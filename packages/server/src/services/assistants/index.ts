import { stripProtectedFields } from '../../utils/stripProtectedFields'
import { extractResponseContent, ICommonObject, resolveSafeChatModelSelection } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { cloneDeep, isEqual, uniqWith } from 'lodash'
import OpenAI from 'openai'
import { DeleteResult, In, QueryRunner } from 'typeorm'
import { validate as validateUuid } from 'uuid'
import { Assistant } from '../../database/entities/Assistant'
import { Credential } from '../../database/entities/Credential'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { Workspace } from '../../enterprise/database/entities/workspace.entity'
import { WorkspaceShared } from '../../enterprise/database/entities/EnterpriseEntities'
import { getWorkspaceSearchOptions } from '../../enterprise/utils/ControllerServiceUtils'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { AssistantType } from '../../Interface'
import { FLOWISE_COUNTER_STATUS, FLOWISE_METRIC_COUNTERS } from '../../Interface.Metrics'
import { databaseEntities, decryptCredentialData, getAppVersion } from '../../utils'
import { INPUT_PARAMS_TYPE } from '../../utils/constants'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { ASSISTANT_PROMPT_GENERATOR } from '../../utils/prompt'
import { checkUsageLimit } from '../../utils/quotaUsage'
import nodesService from '../nodes'
import credentialsService from '../credentials'
import { deleteCustomAssistant } from './customAssistantDelete'
import { getCustomAssistantFlow, saveCustomAssistant } from './customAssistantSave'
import { assertAssistantCreationAllowed } from './legacyPolicy'
import { createWorkspaceOAuth2RefreshCapability } from '../oauth2CredentialRefresh'

const rethrowIfFlowiseError = (error: unknown): void => {
    if (error instanceof InternalFlowiseError) throw error
}

const resolveCredentialForWorkspace = async (credentialId: string, workspaceId: string): Promise<Credential> => {
    if (!credentialId || !workspaceId) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Credential not found')
    }
    const appServer = getRunningExpressApp()
    const credentialRepository = appServer.AppDataSource.getRepository(Credential)
    const ownedCredential = await credentialRepository.findOneBy({ id: credentialId, workspaceId })
    if (ownedCredential) return ownedCredential

    const sharedCredential = await appServer.AppDataSource.getRepository(WorkspaceShared).findOneBy({
        workspaceId,
        sharedItemId: credentialId,
        itemType: 'credential'
    })
    if (sharedCredential) {
        const credential = await credentialRepository.findOneBy({ id: credentialId })
        if (credential) return credential
    }
    throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Credential not found')
}

const parseDetails = (details: unknown, errorMessage: string): Record<string, any> => {
    if (typeof details !== 'string' || details.length === 0) {
        throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, errorMessage)
    }
    try {
        const parsed = JSON.parse(details)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object')
        return parsed
    } catch {
        throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, errorMessage)
    }
}

const getStoredProviderAssistantId = (details: unknown): string => {
    const providerId = parseDetails(details, 'Stored assistant details are invalid').id
    if (typeof providerId !== 'string' || providerId.length === 0) {
        throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'Stored assistant details are invalid')
    }
    return providerId
}

const createOpenAIClientForWorkspace = async (credentialId: string, workspaceId: string): Promise<OpenAI> => {
    const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
    const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
    const openAIApiKey = decryptedCredentialData['openAIApiKey']
    if (typeof openAIApiKey !== 'string' || openAIApiKey.length === 0) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'OpenAI ApiKey not found')
    }
    return new OpenAI({ apiKey: openAIApiKey })
}

const getProviderUpdateParams = (details: Record<string, any>, existingFunctionTools: any[] = []): any => {
    const selectedTools = Array.isArray(details.tools)
        ? details.tools.filter((tool: unknown) => typeof tool === 'string').map((tool: string) => ({ type: tool }))
        : []
    let tools = uniqWith([...existingFunctionTools, ...selectedTools], isEqual)
    tools = tools.filter((tool) => !(tool.type === 'function' && !(tool as any).function))

    const toolResources = cloneDeep(details.tool_resources)
    if (toolResources?.file_search) {
        toolResources.file_search = { vector_store_ids: toolResources.file_search.vector_store_ids }
    }
    if (toolResources?.code_interpreter) {
        toolResources.code_interpreter = { file_ids: toolResources.code_interpreter.file_ids }
    }

    return {
        name: details.name,
        description: details.description,
        instructions: details.instructions,
        model: details.model,
        tools,
        tool_resources: toolResources,
        temperature: details.temperature,
        top_p: details.top_p
    }
}

const getProviderCompensationParams = (assistant: any): any => ({
    name: assistant.name,
    description: assistant.description,
    instructions: assistant.instructions,
    model: assistant.model,
    tools: assistant.tools,
    tool_resources: assistant.tool_resources,
    temperature: assistant.temperature,
    top_p: assistant.top_p
})

const createAssistant = async (requestBody: any, orgId: string, workspaceId: string): Promise<Assistant> => {
    try {
        assertAssistantCreationAllowed(requestBody?.type)
        const appServer = getRunningExpressApp()
        if (!requestBody.details) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'Assistant details are required')
        }
        let assistantDetails: unknown
        try {
            assistantDetails = JSON.parse(requestBody.details)
        } catch {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'Assistant details must be valid JSON')
        }
        if (!assistantDetails || typeof assistantDetails !== 'object' || !('name' in assistantDetails)) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'Assistant details must include a name')
        }

        // For CUSTOM assistants the credential field is a client-generated UUID used as an
        // internal identifier, not a reference to the Credential entity, so no lookup is needed.
        const newAssistant = new Assistant()
        Object.assign(newAssistant, stripProtectedFields(requestBody))
        newAssistant.workspaceId = workspaceId

        const assistant = appServer.AppDataSource.getRepository(Assistant).create(newAssistant)
        const dbResponse = await appServer.AppDataSource.getRepository(Assistant).save(assistant)

        const observabilityTasks: Promise<unknown>[] = [
            (async () =>
                appServer.telemetry.sendTelemetry(
                    'assistant_created',
                    {
                        version: await getAppVersion(),
                        assistantId: dbResponse.id
                    },
                    orgId
                ))()
        ]
        if (appServer.metricsProvider) {
            observabilityTasks.push(
                Promise.resolve().then(() =>
                    appServer.metricsProvider?.incrementCounter(FLOWISE_METRIC_COUNTERS.ASSISTANT_CREATED, {
                        status: FLOWISE_COUNTER_STATUS.SUCCESS
                    })
                )
            )
        }
        const observabilityResults = await Promise.allSettled(observabilityTasks)
        const failedCount = observabilityResults.filter((result) => result.status === 'rejected').length
        if (failedCount > 0) {
            logger.error('[server]: Assistant create observability failed', {
                failedCount,
                totalCount: observabilityTasks.length
            })
        }

        return dbResponse
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to create assistant')
    }
}

const deleteAssistant = async (assistantId: string, isDeleteBoth: boolean, workspaceId: string): Promise<DeleteResult> => {
    try {
        if (typeof isDeleteBoth !== 'boolean') {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'isDeleteBoth must be true or false')
        }
        const appServer = getRunningExpressApp()
        const assistantRepository = appServer.AppDataSource.getRepository(Assistant)
        const assistant = await assistantRepository.findOneBy({ id: assistantId, workspaceId })
        if (!assistant) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Assistant not found')
        }
        if (assistant.type === 'CUSTOM') {
            const customDetails = parseDetails(assistant.details, 'Stored assistant details are invalid')
            if (Object.prototype.hasOwnProperty.call(customDetails, 'flowId')) {
                throw new InternalFlowiseError(
                    StatusCodes.CONFLICT,
                    'Linked custom assistants must be deleted through the custom assistant endpoint'
                )
            }
            const dbResponse = await assistantRepository.delete({ id: assistantId, workspaceId, type: 'CUSTOM' })
            if (dbResponse.affected !== 1) {
                throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete assistant')
            }
            return dbResponse
        }
        if (assistant.type !== 'OPENAI') {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid assistant type')
        }
        const localDeleteCriteria = {
            id: assistantId,
            workspaceId,
            type: 'OPENAI' as const,
            credential: assistant.credential,
            details: assistant.details
        }
        if (!isDeleteBoth) {
            const dbResponse = await assistantRepository.delete(localDeleteCriteria)
            if (dbResponse.affected !== 1) {
                throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete assistant')
            }
            return dbResponse
        }

        const providerAssistantId = getStoredProviderAssistantId(assistant.details)
        const openai = await createOpenAIClientForWorkspace(assistant.credential, workspaceId)
        let providerDeleteResponse: any
        try {
            providerDeleteResponse = await openai.beta.assistants.delete(providerAssistantId)
        } catch {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete assistant')
        }
        if (providerDeleteResponse?.id !== providerAssistantId || providerDeleteResponse?.deleted !== true) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete assistant')
        }

        try {
            const dbResponse = await assistantRepository.delete(localDeleteCriteria)
            if (dbResponse.affected !== 1) throw new Error('database delete did not affect exactly one row')
            return dbResponse
        } catch {
            logger.error('[server]: OpenAI assistant delete reached a partial completion state', {
                providerDeletesSucceeded: 1,
                databaseDeletesSucceeded: 0
            })
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete assistant')
        }
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete assistant')
    }
}

async function getAssistantsCountByOrganization(type: AssistantType, organizationId: string): Promise<number> {
    try {
        const appServer = getRunningExpressApp()

        const workspaces = await appServer.AppDataSource.getRepository(Workspace).findBy({ organizationId })
        const workspaceIds = workspaces.map((workspace) => workspace.id)
        const assistantsCount = await appServer.AppDataSource.getRepository(Assistant).countBy({
            type,
            workspaceId: In(workspaceIds)
        })

        return assistantsCount
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: assistantsService.getAssistantsCountByOrganization - ${getErrorMessage(error)}`
        )
    }
}

const getAllAssistants = async (workspaceId: string, type?: AssistantType): Promise<Assistant[]> => {
    try {
        const appServer = getRunningExpressApp()
        if (type) {
            const dbResponse = await appServer.AppDataSource.getRepository(Assistant).findBy({
                type,
                ...getWorkspaceSearchOptions(workspaceId)
            })
            return dbResponse
        }
        const dbResponse = await appServer.AppDataSource.getRepository(Assistant).findBy(getWorkspaceSearchOptions(workspaceId))
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: assistantsService.getAllAssistants - ${getErrorMessage(error)}`
        )
    }
}

const getAllAssistantsCount = async (workspaceId: string, type?: AssistantType): Promise<number> => {
    try {
        const appServer = getRunningExpressApp()
        if (type) {
            const dbResponse = await appServer.AppDataSource.getRepository(Assistant).countBy({
                type,
                ...getWorkspaceSearchOptions(workspaceId)
            })
            return dbResponse
        }
        const dbResponse = await appServer.AppDataSource.getRepository(Assistant).countBy(getWorkspaceSearchOptions(workspaceId))
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: assistantsService.getAllAssistantsCount - ${getErrorMessage(error)}`
        )
    }
}

const getAssistantById = async (assistantId: string, workspaceId: string): Promise<Assistant> => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(Assistant).findOneBy({
            id: assistantId,
            workspaceId: workspaceId
        })
        if (!dbResponse) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Assistant ${assistantId} not found`)
        }
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: assistantsService.getAssistantById - ${getErrorMessage(error)}`
        )
    }
}

const updateAssistant = async (assistantId: string, requestBody: any, workspaceId: string): Promise<Assistant> => {
    try {
        const appServer = getRunningExpressApp()
        const assistant = await appServer.AppDataSource.getRepository(Assistant).findOneBy({
            id: assistantId,
            workspaceId: workspaceId
        })

        if (!assistant) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Assistant not found')
        }

        if (assistant.type === 'CUSTOM') {
            throw new InternalFlowiseError(
                StatusCodes.CONFLICT,
                'Custom assistants must be updated through the snapshot-bound custom save endpoint'
            )
        }

        if (requestBody.type !== undefined && requestBody.type !== assistant.type) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Assistant type cannot be changed')
        }
        if (assistant.type === 'OPENAI' && requestBody.credential !== undefined && requestBody.credential !== assistant.credential) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Assistant credential cannot be changed')
        }

        if (requestBody.details !== undefined) {
            if (!requestBody.details) {
                throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Details cannot be empty`)
            }
            parseDetails(requestBody.details, 'Details must be valid JSON')
        }

        if (assistant.type !== 'OPENAI') {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid assistant type')
        }

        const providerAssistantId = getStoredProviderAssistantId(assistant.details)
        const assistantDetails = parseDetails(requestBody.details, 'Details must be valid JSON')
        if (assistantDetails.id !== undefined && assistantDetails.id !== providerAssistantId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Provider assistant ID cannot be changed')
        }
        const savedToolResources = cloneDeep(assistantDetails.tool_resources)
        const openai = await createOpenAIClientForWorkspace(assistant.credential, workspaceId)
        let retrievedAssistant: any
        try {
            retrievedAssistant = await openai.beta.assistants.retrieve(providerAssistantId)
            if (retrievedAssistant?.id !== providerAssistantId) {
                throw new Error('provider returned an unexpected assistant')
            }
            const existingFunctionTools = Array.isArray(retrievedAssistant.tools)
                ? retrievedAssistant.tools.filter((tool: any) => tool?.type === 'function')
                : []
            const updatedAssistant = await openai.beta.assistants.update(
                providerAssistantId,
                getProviderUpdateParams(assistantDetails, existingFunctionTools)
            )
            if (updatedAssistant?.id !== providerAssistantId) {
                throw new Error('provider returned an unexpected assistant')
            }
        } catch {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to update assistant')
        }

        const newAssistantDetails: Record<string, any> = { ...assistantDetails, id: providerAssistantId }
        if (savedToolResources) newAssistantDetails.tool_resources = savedToolResources
        assistant.details = JSON.stringify(newAssistantDetails)
        if (requestBody.iconSrc !== undefined) assistant.iconSrc = requestBody.iconSrc

        try {
            return await appServer.AppDataSource.getRepository(Assistant).save(assistant)
        } catch {
            let compensationSucceeded = false
            try {
                const compensation = await openai.beta.assistants.update(
                    providerAssistantId,
                    getProviderCompensationParams(retrievedAssistant)
                )
                compensationSucceeded = compensation?.id === providerAssistantId
            } catch {
                compensationSucceeded = false
            }
            logger.error('[server]: OpenAI assistant update database persistence failed', {
                providerUpdatesSucceeded: 1,
                databaseUpdatesSucceeded: 0,
                compensationsAttempted: 1,
                compensationsSucceeded: compensationSucceeded ? 1 : 0
            })
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to update assistant')
        }
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to update assistant')
    }
}

const importAssistants = async (
    newAssistants: Partial<Assistant>[],
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    queryRunner?: QueryRunner
): Promise<any> => {
    try {
        if (!Array.isArray(newAssistants)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Assistants import must be an array')
        }
        if (newAssistants.length === 0) return
        for (const assistant of newAssistants) {
            assertAssistantCreationAllowed(assistant?.type)
            if (assistant.id !== undefined && (typeof assistant.id !== 'string' || !validateUuid(assistant.id))) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Assistant ID must be a valid UUID')
            }
        }

        const appServer = getRunningExpressApp()
        const repository = queryRunner ? queryRunner.manager.getRepository(Assistant) : appServer.AppDataSource.getRepository(Assistant)

        await checkUsageLimit('flows', subscriptionId, appServer.usageCacheManager, newAssistants.length)

        const validIds = newAssistants.flatMap((assistant) => (assistant.id ? [assistant.id] : []))
        const existing = validIds.length ? await repository.findBy({ id: In(validIds), workspaceId }) : []
        const foundIds = new Set(existing.map((assistant) => assistant.id))

        const prepVariables: Partial<Assistant>[] = newAssistants.map((newAssistant) => {
            const sanitized = stripProtectedFields(newAssistant as Record<string, unknown>) as Partial<Assistant>
            if (newAssistant.id && !foundIds.has(newAssistant.id)) sanitized.id = newAssistant.id
            sanitized.workspaceId = workspaceId
            return sanitized
        })

        return await repository.insert(prepVariables)
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to import assistants')
    }
}

const getChatModels = async (): Promise<any> => {
    try {
        const dbResponse = await nodesService.getAllNodesForCategory('Chat Models')
        return dbResponse.filter((node) => !node.tags?.includes('LlamaIndex'))
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: assistantsService.getChatModels - ${getErrorMessage(error)}`
        )
    }
}

const getDocumentStores = async (activeWorkspaceId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const stores = await appServer.AppDataSource.getRepository(DocumentStore).findBy(getWorkspaceSearchOptions(activeWorkspaceId))
        const returnData = []
        for (const store of stores) {
            if (store.status === 'UPSERTED') {
                const obj = {
                    name: store.id,
                    label: store.name,
                    description: store.description
                }
                returnData.push(obj)
            }
        }
        return returnData
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: assistantsService.getDocumentStores - ${getErrorMessage(error)}`
        )
    }
}

const getTools = async (): Promise<any> => {
    try {
        const tools = await nodesService.getAllNodesForCategory('Tools')
        const mcpTools = await nodesService.getAllNodesForCategory('Tools (MCP)')

        // filter out those tools that input params type are not in the list
        const filteredTools = [...tools, ...mcpTools].filter((tool) => {
            const inputs = tool.inputs || []
            return inputs.every((input) => INPUT_PARAMS_TYPE.includes(input.type))
        })
        return filteredTools
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: assistantsService.getTools - ${getErrorMessage(error)}`)
    }
}

const generateAssistantInstruction = async (
    task: string,
    selectedChatModel: ICommonObject,
    workspaceId: string
): Promise<ICommonObject> => {
    try {
        if (typeof task !== 'string' || !task.trim() || task.length > 4096) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid assistant instruction task')
        }
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Assistant instruction generation is not authorized')
        const appServer = getRunningExpressApp()
        let safeChatModel: ReturnType<typeof resolveSafeChatModelSelection>
        try {
            safeChatModel = resolveSafeChatModelSelection(appServer.nodesPool.componentNodes, selectedChatModel)
        } catch {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid assistant chat model selection')
        }
        if (safeChatModel.credentialId) {
            try {
                await credentialsService.assertCredentialInWorkspace(safeChatModel.credentialId, workspaceId)
            } catch {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Assistant chat model credential not found')
            }
        }
        const nodeModule = await import(safeChatModel.component.filePath as string)
        const newNodeInstance = new nodeModule.nodeClass()
        const options: ICommonObject = {
            appDataSource: appServer.AppDataSource,
            databaseEntities,
            workspaceId,
            skipVariables: true,
            refreshOAuth2Credential: createWorkspaceOAuth2RefreshCapability(workspaceId),
            logger
        }
        const llmNodeInstance = await newNodeInstance.init(safeChatModel.nodeData, '', options)
        const response = await llmNodeInstance.invoke([
            {
                role: 'user',
                content: ASSISTANT_PROMPT_GENERATOR.replace('{{task}}', task.trim())
            }
        ])
        const content = extractResponseContent(response)
        return { content }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        logger.error('assistant_instruction_generation_failed', { failedCount: 1 })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Assistant instruction generation failed')
    }
}

export default {
    createAssistant,
    deleteAssistant,
    getAllAssistants,
    getAllAssistantsCount,
    getAssistantById,
    updateAssistant,
    getCustomAssistantFlow,
    saveCustomAssistant,
    deleteCustomAssistant,
    importAssistants,
    getChatModels,
    getDocumentStores,
    getTools,
    generateAssistantInstruction,
    getAssistantsCountByOrganization
}
