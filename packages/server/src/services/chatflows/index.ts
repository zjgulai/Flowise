import { randomBytes } from 'crypto'
import { ICommonObject, removeFolderFromStorage } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { Brackets, In, IsNull, QueryRunner } from 'typeorm'
import { validate as isValidUUID } from 'uuid'
import { ChatflowType, IReactFlowObject, ScheduleInputMode, StartInputType } from '../../Interface'
import { FLOWISE_COUNTER_STATUS, FLOWISE_METRIC_COUNTERS } from '../../Interface.Metrics'
import { UsageCacheManager } from '../../UsageCacheManager'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { ScheduleTriggerType } from '../../database/entities/ScheduleRecord'
import { UpsertHistory } from '../../database/entities/UpsertHistory'
import { Workspace } from '../../enterprise/database/entities/workspace.entity'
import { getWorkspaceSearchOptions } from '../../enterprise/utils/ControllerServiceUtils'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { ScheduleBeat } from '../../schedule/ScheduleBeat'
import documentStoreService from '../../services/documentstore'
import { parseCanonicalDocumentStoreReference } from '../../services/documentstore/documentStoreReferences'
import scheduleService from '../../services/schedule'
import {
    constructGraphs,
    decryptCredentialData,
    encryptCredentialData,
    getAppVersion,
    getEndingNodes,
    getTelemetryFlowObj,
    isFlowValidForStream
} from '../../utils'
import { containsBase64File, updateFlowDataWithFilePaths } from '../../utils/fileRepository'
import { sanitizeAllowedUploadMimeTypesFromConfig } from '../../utils/fileValidation'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { utilGetUploadsConfig } from '../../utils/getUploadsConfig'
import logger from '../../utils/logger'
import { updateStorageUsage } from '../../utils/quotaUsage'
import { sanitizeFlowDataForPublicEndpoint } from '../../utils/sanitizeFlowData'
import { assertChatflowNotLinkedToCustomAssistant } from '../assistants/customAssistantDelete'
import {
    GENERIC_CHATFLOW_TYPES,
    GenericChatflowType,
    requireGenericChatflowType,
    requirePermittedChatflowType,
    stripGenericChatflowServerState
} from './accessControl'

export const enum ChatflowErrorMessage {
    INVALID_CHATFLOW_TYPE = 'Invalid Chatflow Type',
    INVALID_CHATFLOW_ID = 'Invalid Chatflow ID',
    WORKSPACE_ID_REQUIRED = 'Workspace ID is required'
}

export function validateChatflowType(type: ChatflowType | undefined) {
    if (!Object.values(EnumChatflowType).includes(type as EnumChatflowType))
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.INVALID_CHATFLOW_TYPE)
}

type JsonRecord = Record<string, unknown>

const DOCUMENT_STORE_REFERENCE_ERROR = 'Chatflow contains an invalid document store reference'
const DOCUMENT_STORE_NOT_FOUND_ERROR = 'One or more document stores were not found in the workspace'

const isJsonRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value)

const invalidDocumentStoreReference = (): never => {
    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, DOCUMENT_STORE_REFERENCE_ERROR)
}

const parseDocumentStoreId = (value: unknown, prefixed: boolean): string => {
    const reference = parseCanonicalDocumentStoreReference(value, prefixed)
    return reference?.storeId ?? invalidDocumentStoreReference()
}

/**
 * Extract every DocumentStore reference that can be executed by a saved flow.
 * The parser intentionally accepts the legacy empty-string sentinel for empty
 * Agent/Retriever knowledge arrays, but rejects every other type mismatch.
 */
export const extractDocumentStoreIds = (flowData: unknown): string[] => {
    if (typeof flowData !== 'string') return invalidDocumentStoreReference()

    let parsed: unknown
    try {
        parsed = JSON.parse(flowData)
    } catch {
        return invalidDocumentStoreReference()
    }
    if (!isJsonRecord(parsed)) return invalidDocumentStoreReference()
    if (parsed.nodes === undefined) return []
    if (!Array.isArray(parsed.nodes)) return invalidDocumentStoreReference()

    const documentStoreIds = new Set<string>()
    for (const node of parsed.nodes) {
        if (!isJsonRecord(node) || !isJsonRecord(node.data)) return invalidDocumentStoreReference()
        const name = node.data.name
        if (typeof name !== 'string') return invalidDocumentStoreReference()

        if (name === 'documentStore' || name === 'documentStoreVS') {
            if (!isJsonRecord(node.data.inputs) || !Object.prototype.hasOwnProperty.call(node.data.inputs, 'selectedStore')) {
                return invalidDocumentStoreReference()
            }
            documentStoreIds.add(parseDocumentStoreId(node.data.inputs.selectedStore, false))
        }

        const knowledgeInputName =
            name === 'agentAgentflow'
                ? 'agentKnowledgeDocumentStores'
                : name === 'retrieverAgentflow'
                ? 'retrieverKnowledgeDocumentStores'
                : undefined
        if (!knowledgeInputName) continue
        if (!isJsonRecord(node.data.inputs)) return invalidDocumentStoreReference()

        const knowledgeStores = node.data.inputs[knowledgeInputName]
        if (knowledgeStores === undefined || knowledgeStores === '') continue
        if (!Array.isArray(knowledgeStores)) return invalidDocumentStoreReference()
        for (const knowledgeStore of knowledgeStores) {
            if (!isJsonRecord(knowledgeStore) || !Object.prototype.hasOwnProperty.call(knowledgeStore, 'documentStore')) {
                return invalidDocumentStoreReference()
            }
            documentStoreIds.add(parseDocumentStoreId(knowledgeStore.documentStore, true))
        }
    }
    return [...documentStoreIds]
}

const assertDocumentStoresInWorkspace = async (flowData: unknown, workspaceId?: string): Promise<string[]> => {
    if (!workspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.WORKSPACE_ID_REQUIRED)
    }
    const documentStoreIds = extractDocumentStoreIds(flowData)
    const repository = getRunningExpressApp().AppDataSource.getRepository(DocumentStore)
    for (const id of documentStoreIds) {
        const store = await repository.findOneBy({ id, workspaceId })
        if (!store) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, DOCUMENT_STORE_NOT_FOUND_ERROR)
    }
    return documentStoreIds
}

// Check if chatflow valid for streaming
const checkIfChatflowIsValidForStreaming = async (chatflowId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        //**
        const chatflow = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: chatflowId
        })
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }
        if (chatflow.type === EnumChatflowType.ASSISTANT) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }

        /* Check for post-processing settings, if available isStreamValid is always false */
        let chatflowConfig: ICommonObject = {}
        if (chatflow.chatbotConfig) {
            chatflowConfig = JSON.parse(chatflow.chatbotConfig)
            if (chatflowConfig?.postProcessing?.enabled === true) {
                return { isStreaming: false }
            }
        }

        if (chatflow.type === 'AGENTFLOW') {
            return { isStreaming: true }
        }

        /*** Get Ending Node with Directed Graph  ***/
        const flowData = chatflow.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = parsedFlowData.nodes
        const edges = parsedFlowData.edges
        const { graph, nodeDependencies } = constructGraphs(nodes, edges)

        const endingNodes = getEndingNodes(nodeDependencies, graph, nodes)

        let isStreaming = false
        for (const endingNode of endingNodes) {
            const endingNodeData = endingNode.data
            const isEndingNode = endingNodeData?.outputs?.output === 'EndingNode'
            // Once custom function ending node exists, flow is always unavailable to stream
            if (isEndingNode) {
                return { isStreaming: false }
            }
            isStreaming = isFlowValidForStream(nodes, endingNodeData)
        }

        // If it is a Multi/Sequential Agents, always enable streaming
        if (endingNodes.filter((node) => node.data.category === 'Multi Agents' || node.data.category === 'Sequential Agents').length > 0) {
            return { isStreaming: true }
        }

        const dbResponse = { isStreaming: isStreaming }
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.checkIfChatflowIsValidForStreaming - ${getErrorMessage(error)}`
        )
    }
}

// Check if chatflow valid for uploads
const checkIfChatflowIsValidForUploads = async (chatflowId: string): Promise<any> => {
    try {
        const chatflow = await getRunningExpressApp()
            .AppDataSource.getRepository(ChatFlow)
            .findOne({
                where: { id: chatflowId },
                select: ['id', 'type']
            })
        if (!chatflow || chatflow.type === EnumChatflowType.ASSISTANT) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }
        const dbResponse = await utilGetUploadsConfig(chatflowId)
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.checkIfChatflowIsValidForUploads - ${getErrorMessage(error)}`
        )
    }
}

const deleteChatflow = async (
    chatflowId: string,
    orgId: string,
    workspaceId: string,
    userPermittedTypes: EnumChatflowType[]
): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()

        const chatflow = await getChatflowById(chatflowId, workspaceId)
        if (!userPermittedTypes.includes(chatflow.type as EnumChatflowType))
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, `You do not have permission to delete this chatflow type`)

        if (chatflow.type === EnumChatflowType.ASSISTANT) {
            await assertChatflowNotLinkedToCustomAssistant(appServer.AppDataSource, chatflowId, workspaceId)
        }

        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).delete({ id: chatflowId })

        // Update document store usage
        await documentStoreService.updateDocumentStoreUsage(chatflowId, undefined, workspaceId)

        // Delete all chat messages
        await appServer.AppDataSource.getRepository(ChatMessage).delete({ chatflowid: chatflowId })

        // Delete all chat feedback
        await appServer.AppDataSource.getRepository(ChatMessageFeedback).delete({ chatflowid: chatflowId })

        // Delete all upsert history
        await appServer.AppDataSource.getRepository(UpsertHistory).delete({ chatflowid: chatflowId })

        // delete schedules related to the chatflow if it's an agentflow
        if (chatflow.type === EnumChatflowType.AGENTFLOW) {
            const existingRecord = await scheduleService.deleteScheduleForTarget(chatflow.id, ScheduleTriggerType.AGENTFLOW, workspaceId)
            if (existingRecord) {
                await ScheduleBeat.getInstance().onScheduleChanged(existingRecord.id, 'delete')
            }
        }

        try {
            // Delete all uploads corresponding to this chatflow
            const { totalSize } = await removeFolderFromStorage(orgId, chatflowId)
            await updateStorageUsage(orgId, workspaceId, totalSize, appServer.usageCacheManager)
        } catch (e) {
            logger.error(`[server]: Error deleting file storage for chatflow ${chatflowId}`)
        }
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        logger.error('[server]: Chatflow deletion failed', { failedCount: 1 })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete chatflow')
    }
}

const getAllChatflows = async (
    type?: ChatflowType,
    workspaceId?: string,
    page: number = -1,
    limit: number = -1,
    search?: string,
    orderBy?: 'name' | 'updatedDate',
    order?: 'asc' | 'desc',
    permittedTypes?: readonly GenericChatflowType[]
) => {
    try {
        const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
        if (!scopedWorkspaceId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.WORKSPACE_ID_REQUIRED)
        }
        if (type !== undefined) validateChatflowType(type)
        if (permittedTypes !== undefined) {
            if (permittedTypes.length === 0) {
                throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'You do not have permission to view any flow types')
            }
            for (const permittedType of permittedTypes) requireGenericChatflowType(permittedType)
            if (type !== undefined) requirePermittedChatflowType(type, permittedTypes)
        }

        const appServer = getRunningExpressApp()

        const sortColumn = orderBy === 'name' ? 'chat_flow.name' : 'chat_flow.updatedDate'
        const sortDirection = order === 'asc' ? 'ASC' : 'DESC'
        const queryBuilder = appServer.AppDataSource.getRepository(ChatFlow)
            .createQueryBuilder('chat_flow')
            .orderBy(sortColumn, sortDirection)
            .addOrderBy('chat_flow.id', 'ASC')

        if (page > 0 && limit > 0) {
            queryBuilder.skip((page - 1) * limit)
            queryBuilder.take(limit)
        }
        if (type === 'MULTIAGENT') {
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'MULTIAGENT' })
        } else if (type === 'AGENTFLOW') {
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'AGENTFLOW' })
        } else if (type === 'ASSISTANT') {
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'ASSISTANT' })
        } else if (type === 'CHATFLOW') {
            // fetch all chatflows that are not agentflow
            queryBuilder.andWhere('chat_flow.type = :type', { type: 'CHATFLOW' })
        }
        queryBuilder.andWhere('chat_flow.workspaceId = :workspaceId', { workspaceId: scopedWorkspaceId })
        if (permittedTypes !== undefined) {
            queryBuilder.andWhere('chat_flow.type IN (:...permittedTypes)', { permittedTypes })
        }
        if (search) {
            const idSearchExpression =
                appServer.AppDataSource.options.type === 'postgres' ? 'LOWER(CAST(chat_flow.id AS TEXT))' : 'LOWER(chat_flow.id)'
            queryBuilder.andWhere(
                `(LOWER(chat_flow.name) LIKE :search OR LOWER(COALESCE(chat_flow.category, '')) LIKE :search OR ${idSearchExpression} LIKE :search)`,
                { search: `%${search.toLowerCase()}%` }
            )
        }
        const [data, total] = await queryBuilder.getManyAndCount()

        if (page > 0 && limit > 0) {
            return { data, total }
        } else {
            return data
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getAllChatflows - ${getErrorMessage(error)}`
        )
    }
}

async function getAllChatflowsCountByOrganization(type: ChatflowType, organizationId: string): Promise<number> {
    try {
        const appServer = getRunningExpressApp()

        const workspaces = await appServer.AppDataSource.getRepository(Workspace).findBy({ organizationId })
        const workspaceIds = workspaces.map((workspace) => workspace.id)
        const chatflowsCount = await appServer.AppDataSource.getRepository(ChatFlow).countBy({
            type,
            workspaceId: In(workspaceIds)
        })

        return chatflowsCount
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getAllChatflowsCountByOrganization - ${getErrorMessage(error)}`
        )
    }
}

const getAllChatflowsCount = async (type?: ChatflowType, workspaceId?: string): Promise<number> => {
    try {
        const appServer = getRunningExpressApp()
        if (type) {
            const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).countBy({
                type,
                ...getWorkspaceSearchOptions(workspaceId)
            })
            return dbResponse
        }
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).countBy(getWorkspaceSearchOptions(workspaceId))
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getAllChatflowsCount - ${getErrorMessage(error)}`
        )
    }
}

const getChatflowByApiKey = async (apiKeyId: string, workspaceId: string, keyonly?: unknown): Promise<any> => {
    try {
        // Here we only get chatflows that are bounded by the apikeyid and chatflows that are not bounded by any apikey
        const appServer = getRunningExpressApp()
        let query = appServer.AppDataSource.getRepository(ChatFlow)
            .createQueryBuilder('cf')
            .where('cf.workspaceId = :workspaceId', { workspaceId })
            .andWhere('cf.type IN (:...genericTypes)', { genericTypes: [...GENERIC_CHATFLOW_TYPES] })
            .andWhere(
                new Brackets((qb) => {
                    qb.where('cf.apikeyid = :apikeyid', { apikeyid: apiKeyId })
                    if (keyonly === undefined) {
                        qb.orWhere('cf.apikeyid IS NULL').orWhere('cf.apikeyid = ""')
                    }
                })
            )

        const dbResponse = await query.orderBy('cf.name', 'ASC').getMany()
        if (dbResponse.length < 1) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow not found in the database!`)
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getChatflowByApiKey - ${getErrorMessage(error)}`
        )
    }
}

const getChatflowById = async (chatflowId: string, workspaceId?: string): Promise<any> => {
    try {
        if (!isValidUUID(chatflowId)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.INVALID_CHATFLOW_ID)
        }
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).findOne({
            where: {
                id: chatflowId,
                ...(workspaceId ? { workspaceId } : {})
            }
        })
        if (!dbResponse) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found in the database!`)
        }
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        logger.error('[server]: Chatflow lookup failed', { failedCount: 1 })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load chatflow')
    }
}

/** Resolves a chatflow only if it belongs to the given workspace; rejects when workspaceId is missing (prevents unscoped lookup). */
const getChatflowByIdForWorkspace = async (chatflowId: string, workspaceId: string | undefined): Promise<any> => {
    if (!workspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.WORKSPACE_ID_REQUIRED)
    }
    return getChatflowById(chatflowId, workspaceId)
}

const assertChatflowInWorkspaceAndTypes = async (
    chatflowId: string,
    workspaceId: string | undefined,
    permittedTypes: readonly GenericChatflowType[]
): Promise<GenericChatflowType> => {
    const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (!scopedWorkspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.WORKSPACE_ID_REQUIRED)
    }
    if (!isValidUUID(chatflowId)) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.INVALID_CHATFLOW_ID)
    }
    if (permittedTypes.length === 0) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'You do not have permission for this flow type')
    }
    for (const permittedType of permittedTypes) requireGenericChatflowType(permittedType)

    const row = await getRunningExpressApp()
        .AppDataSource.getRepository(ChatFlow)
        .findOne({
            where: { id: chatflowId, workspaceId: scopedWorkspaceId },
            select: ['id', 'type']
        })
    if (!row) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found in the database!`)
    }
    return requirePermittedChatflowType(row.type, permittedTypes)
}

const getChatflowByIdForWorkspaceAndTypes = async (
    chatflowId: string,
    workspaceId: string | undefined,
    permittedTypes: readonly GenericChatflowType[]
): Promise<ChatFlow> => {
    const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    const permittedType = await assertChatflowInWorkspaceAndTypes(chatflowId, scopedWorkspaceId, permittedTypes)
    const chatflow = await getRunningExpressApp()
        .AppDataSource.getRepository(ChatFlow)
        .findOne({
            where: { id: chatflowId, workspaceId: scopedWorkspaceId, type: permittedType }
        })
    if (!chatflow) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Chatflow changed concurrently')
    }
    return chatflow
}

/** Ensures every id exists as a chatflow in workspaceId. One DB query; pass queryRunner when inside a transaction for consistent reads. */
const assertChatflowIdsInWorkspace = async (chatflowIds: string[], workspaceId: string, queryRunner?: QueryRunner): Promise<void> => {
    try {
        if (chatflowIds.length === 0) return
        for (const id of chatflowIds) {
            if (!isValidUUID(id)) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, ChatflowErrorMessage.INVALID_CHATFLOW_ID)
            }
        }
        const appServer = getRunningExpressApp()
        const manager = queryRunner?.manager ?? appServer.AppDataSource.manager
        const found = await manager.getRepository(ChatFlow).find({
            where: { id: In(chatflowIds), workspaceId },
            select: ['id']
        })
        if (found.length !== chatflowIds.length) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                'Error: chatflowsService.assertChatflowIdsInWorkspace - one or more chatflows were not found in the workspace!'
            )
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.assertChatflowIdsInWorkspace - ${getErrorMessage(error)}`
        )
    }
}

const saveChatflow = async (
    newChatFlow: ChatFlow,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager
): Promise<any> => {
    requireGenericChatflowType(newChatFlow.type)
    stripGenericChatflowServerState(newChatFlow)
    await assertDocumentStoresInWorkspace(newChatFlow.flowData, workspaceId)
    const appServer = getRunningExpressApp()
    newChatFlow.workspaceId = workspaceId

    let dbResponse: ChatFlow
    if (containsBase64File(newChatFlow)) {
        // we need a 2-step process, as we need to save the chatflow first and then update the file paths
        // this is because we need the chatflow id to create the file paths

        // step 1 - save with empty flowData
        const incomingFlowData = newChatFlow.flowData
        newChatFlow.flowData = JSON.stringify({})
        const chatflow = appServer.AppDataSource.getRepository(ChatFlow).create(newChatFlow)
        const step1Results = await appServer.AppDataSource.getRepository(ChatFlow).save(chatflow)

        // step 2 - convert base64 to file paths and update the chatflow
        step1Results.flowData = await updateFlowDataWithFilePaths(
            step1Results.id,
            incomingFlowData,
            orgId,
            workspaceId,
            subscriptionId,
            usageCacheManager
        )
        await _checkAndUpdateDocumentStoreUsage(step1Results, newChatFlow.workspaceId)
        dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).save(step1Results)
    } else {
        const chatflow = appServer.AppDataSource.getRepository(ChatFlow).create(newChatFlow)
        dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).save(chatflow)
        await _checkAndUpdateDocumentStoreUsage(dbResponse, workspaceId)
    }

    // Check if the flow is agentflow and if it has a schedule node, if yes then notify the beat to sync the schedule
    if (dbResponse.type === EnumChatflowType.AGENTFLOW) {
        /*** Get chatflows and prepare data  ***/
        const flowData = dbResponse.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = (parsedFlowData.nodes || []).filter((node) => node.data.name !== 'stickyNoteAgentflow')
        const startNode = nodes.find((node) => node.data.name === 'startAgentflow')
        const startInputType = startNode?.data?.inputs?.startInputType as StartInputType | undefined
        if (startInputType === 'scheduleInput') {
            const scheduleInputMode = startNode?.data?.inputs?.scheduleInputMode as ScheduleInputMode | undefined
            if (!scheduleInputMode) {
                throw new InternalFlowiseError(
                    StatusCodes.BAD_REQUEST,
                    'Schedule Input Mode is required on the Start node when Start Input Type is Schedule.'
                )
            }
            const resolvedCron = scheduleService.resolveScheduleCron(startNode?.data?.inputs || {})
            const scheduleTimezone = startNode?.data?.inputs?.scheduleTimezone || 'UTC'
            const scheduleDefaultInput = startNode?.data?.inputs?.scheduleDefaultInput || ''
            const scheduleFormDefaultsRaw = startNode?.data?.inputs?.scheduleFormDefaults
            const scheduleFormDefaults =
                scheduleInputMode === 'form'
                    ? typeof scheduleFormDefaultsRaw === 'string'
                        ? scheduleFormDefaultsRaw
                        : JSON.stringify(scheduleFormDefaultsRaw ?? {})
                    : undefined
            const scheduleEndDate = startNode?.data?.inputs?.scheduleEndDate ? new Date(startNode.data.inputs.scheduleEndDate) : undefined
            const enabled = scheduleService.canScheduleEnable(startNode?.data?.inputs ?? {})
            const record = await scheduleService.createOrUpdateSchedule({
                triggerType: ScheduleTriggerType.AGENTFLOW,
                targetId: dbResponse.id,
                nodeId: startNode?.id,
                cronExpression: resolvedCron.cronExpression || '',
                timezone: scheduleTimezone,
                enabled: enabled,
                scheduleInputMode,
                defaultInput: scheduleInputMode === 'text' ? scheduleDefaultInput : '',
                defaultForm: scheduleFormDefaults,
                workspaceId,
                endDate: scheduleEndDate
            })
            if (enabled) {
                // Notify the beat to sync the schedule
                await ScheduleBeat.getInstance().onScheduleChanged(record.id, 'upsert')
            }
        }
    }

    const productId = await appServer.identityManager.getProductIdFromSubscription(subscriptionId)

    await appServer.telemetry.sendTelemetry(
        'chatflow_created',
        {
            version: await getAppVersion(),
            chatflowId: dbResponse.id,
            flowGraph: getTelemetryFlowObj(JSON.parse(dbResponse.flowData)?.nodes, JSON.parse(dbResponse.flowData)?.edges),
            productId,
            subscriptionId
        },
        orgId
    )

    appServer.metricsProvider?.incrementCounter(
        dbResponse?.type === 'MULTIAGENT' ? FLOWISE_METRIC_COUNTERS.AGENTFLOW_CREATED : FLOWISE_METRIC_COUNTERS.CHATFLOW_CREATED,
        { status: FLOWISE_COUNTER_STATUS.SUCCESS }
    )

    return dbResponse
}

const updateChatflow = async (
    chatflow: ChatFlow,
    updateChatFlow: ChatFlow,
    orgId: string,
    workspaceId: string,
    subscriptionId: string
): Promise<any> => {
    const existingType = requireGenericChatflowType(chatflow.type)
    stripGenericChatflowServerState(updateChatFlow)
    if (updateChatFlow.type !== undefined) {
        const requestedType = requireGenericChatflowType(updateChatFlow.type)
        if (requestedType !== existingType) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Changing a flow type through the generic endpoint is not allowed')
        }
    }
    updateChatFlow.type = existingType
    const candidateFlowData = updateChatFlow.flowData ?? chatflow.flowData
    await assertDocumentStoresInWorkspace(candidateFlowData, workspaceId)
    const appServer = getRunningExpressApp()
    if (updateChatFlow.flowData && containsBase64File(updateChatFlow)) {
        updateChatFlow.flowData = await updateFlowDataWithFilePaths(
            chatflow.id,
            updateChatFlow.flowData,
            orgId,
            workspaceId,
            subscriptionId,
            appServer.usageCacheManager
        )
    }
    if (updateChatFlow.chatbotConfig) {
        try {
            const parsed = JSON.parse(updateChatFlow.chatbotConfig) as ICommonObject
            if (parsed?.fullFileUpload?.allowedUploadFileTypes !== undefined) {
                const current = parsed.fullFileUpload.allowedUploadFileTypes
                const sanitized = sanitizeAllowedUploadMimeTypesFromConfig(typeof current === 'string' ? current : String(current ?? ''))
                parsed.fullFileUpload.allowedUploadFileTypes = sanitized
                updateChatFlow.chatbotConfig = JSON.stringify(parsed)
            }
        } catch (error) {
            const message = getErrorMessage(error)
            logger.error(`[server]: Invalid chatbotConfig JSON in updateChatflow: ${message}`)
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Invalid chatbotConfig: ${message}`)
        }
    }
    const repository = appServer.AppDataSource.getRepository(ChatFlow)
    const newDbChatflow = repository.merge(chatflow, updateChatFlow)
    newDbChatflow.workspaceId = workspaceId // defense-in-depth: use trusted param, not chatflow.workspaceId (merge mutates in-place)
    newDbChatflow.type = existingType

    const updatePayload = { ...updateChatFlow } as Partial<ChatFlow>
    for (const protectedField of [
        'id',
        'workspaceId',
        'type',
        'createdDate',
        'updatedDate',
        'mcpServerConfig',
        'webhookSecret',
        'webhookSecretConfigured'
    ] as const) {
        Reflect.deleteProperty(updatePayload, protectedField)
    }
    if (Object.keys(updatePayload).length > 0) {
        const updateResult = await repository.update({ id: chatflow.id, workspaceId, type: existingType }, updatePayload)
        if (updateResult.affected !== 1) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Chatflow changed concurrently')
        }
    }

    const dbResponse = newDbChatflow
    await _checkAndUpdateDocumentStoreUsage(dbResponse, workspaceId)

    // Check if the flow is agentflow and if it has a schedule node, if yes then notify the beat to sync the schedule
    if (dbResponse.type === EnumChatflowType.AGENTFLOW) {
        const flowData = dbResponse.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = (parsedFlowData.nodes || []).filter((node) => node.data.name !== 'stickyNoteAgentflow')
        const startNode = nodes.find((node) => node.data.name === 'startAgentflow')
        const startInputType = startNode?.data?.inputs?.startInputType as StartInputType | undefined
        if (startInputType === 'scheduleInput') {
            const scheduleInputMode = startNode?.data?.inputs?.scheduleInputMode as ScheduleInputMode | undefined
            if (!scheduleInputMode) {
                throw new InternalFlowiseError(
                    StatusCodes.BAD_REQUEST,
                    'Schedule Input Mode is required on the Start node when Start Input Type is Schedule.'
                )
            }
            const resolvedCron = scheduleService.resolveScheduleCron(startNode?.data?.inputs || {})
            const scheduleTimezone = startNode?.data?.inputs?.scheduleTimezone || 'UTC'
            const scheduleDefaultInput = startNode?.data?.inputs?.scheduleDefaultInput || ''
            const scheduleFormDefaultsRaw = startNode?.data?.inputs?.scheduleFormDefaults
            const scheduleFormDefaults =
                scheduleInputMode === 'form'
                    ? typeof scheduleFormDefaultsRaw === 'string'
                        ? scheduleFormDefaultsRaw
                        : JSON.stringify(scheduleFormDefaultsRaw ?? {})
                    : undefined
            const scheduleEndDate = startNode?.data?.inputs?.scheduleEndDate ? new Date(startNode.data.inputs.scheduleEndDate) : undefined
            const canEnable = scheduleService.canScheduleEnable(startNode?.data?.inputs ?? {})
            const record = await scheduleService.createOrUpdateSchedule({
                triggerType: ScheduleTriggerType.AGENTFLOW,
                targetId: dbResponse.id,
                nodeId: startNode?.id,
                cronExpression: resolvedCron.cronExpression || '',
                timezone: scheduleTimezone,
                enabled: canEnable === false ? false : undefined, // automatically disable schedule if it cannot be enabled; otherwise preserve the existing enabled value
                scheduleInputMode,
                defaultInput: scheduleInputMode === 'text' ? scheduleDefaultInput : '',
                defaultForm: scheduleFormDefaults,
                workspaceId,
                endDate: scheduleEndDate
            })
            if (record.enabled) {
                // Notify the beat to sync the (enabled) schedule
                await ScheduleBeat.getInstance().onScheduleChanged(record.id, 'upsert')
            } else {
                // Schedule is disabled; ensure any existing scheduled job is removed
                await ScheduleBeat.getInstance().onScheduleChanged(record.id, 'delete')
            }
        } else {
            // If the start node is not scheduleInput, then we need to delete the existing schedule if it exists
            const existingRecord = await scheduleService.deleteScheduleForTarget(dbResponse.id, ScheduleTriggerType.AGENTFLOW, workspaceId)
            if (existingRecord) {
                await ScheduleBeat.getInstance().onScheduleChanged(existingRecord.id, 'delete')
            }
        }
    }

    return dbResponse
}

// Get specific chatflow chatbotConfig via id (PUBLIC endpoint, used to retrieve config for embedded chat)
// flowData is sanitized before returning — password, file, folder inputs and credential references are stripped
const getSinglePublicChatbotConfig = async (chatflowId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: chatflowId
        })
        if (!dbResponse) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }
        if (dbResponse.type === EnumChatflowType.ASSISTANT) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }
        const uploadsConfig = await utilGetUploadsConfig(chatflowId)
        // even if chatbotConfig is not set but uploads are enabled
        // send uploadsConfig to the chatbot
        if (dbResponse.chatbotConfig || uploadsConfig) {
            try {
                const parsedConfig = dbResponse.chatbotConfig ? JSON.parse(dbResponse.chatbotConfig) : {}
                const ttsConfig =
                    typeof dbResponse.textToSpeech === 'string' ? JSON.parse(dbResponse.textToSpeech) : dbResponse.textToSpeech

                let isTTSEnabled = false
                if (ttsConfig) {
                    Object.keys(ttsConfig).forEach((provider) => {
                        if (provider !== 'none' && ttsConfig?.[provider]?.status) {
                            isTTSEnabled = true
                        }
                    })
                }
                delete parsedConfig.allowedOrigins
                delete parsedConfig.allowedOriginsError
                return {
                    ...parsedConfig,
                    uploads: uploadsConfig,
                    flowData: sanitizeFlowDataForPublicEndpoint(dbResponse.flowData),
                    isTTSEnabled
                }
            } catch (e) {
                throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error parsing Chatbot Config for Chatflow ${chatflowId}`)
            }
        }
        return 'OK'
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getSinglePublicChatbotConfig - ${getErrorMessage(error)}`
        )
    }
}

const _checkAndUpdateDocumentStoreUsage = async (chatflow: ChatFlow, workspaceId?: string) => {
    const documentStoreIds = extractDocumentStoreIds(chatflow.flowData)
    await documentStoreService.updateDocumentStoreUsage(chatflow.id, documentStoreIds, workspaceId)
}

const checkIfChatflowHasChanged = async (chatflowId: string, lastUpdatedDateTime: string, workspaceId: string): Promise<any> => {
    try {
        const chatflow = await getChatflowByIdForWorkspace(chatflowId, workspaceId)
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
        }
        return { hasChanged: chatflow.updatedDate.toISOString() !== lastUpdatedDateTime }
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.checkIfChatflowHasChanged - ${getErrorMessage(error)}`
        )
    }
}

const setWebhookSecret = async (
    chatflowId: string,
    workspaceId: string,
    permittedTypes: readonly GenericChatflowType[]
): Promise<{ webhookSecret: string }> => {
    try {
        const permittedType = await assertChatflowInWorkspaceAndTypes(chatflowId, workspaceId, permittedTypes)
        const appServer = getRunningExpressApp()
        const repo = appServer.AppDataSource.getRepository(ChatFlow)
        const chatflow = await repo.findOne({
            where: { id: chatflowId, workspaceId, type: permittedType },
            select: ['id', 'type', 'webhookSecret']
        })
        if (!chatflow) throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Chatflow changed concurrently')
        const plaintext = randomBytes(32).toString('hex')
        const webhookSecret = await encryptCredentialData({ secret: plaintext })
        const result = await repo.update(
            {
                id: chatflowId,
                workspaceId,
                type: permittedType,
                webhookSecret: chatflow.webhookSecret == null ? IsNull() : chatflow.webhookSecret
            },
            { webhookSecret, webhookSecretConfigured: true }
        )
        if (result.affected !== 1) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Chatflow changed concurrently')
        }
        return { webhookSecret: plaintext }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.setWebhookSecret - ${getErrorMessage(error)}`
        )
    }
}

const clearWebhookSecret = async (
    chatflowId: string,
    workspaceId: string,
    permittedTypes: readonly GenericChatflowType[]
): Promise<void> => {
    try {
        const permittedType = await assertChatflowInWorkspaceAndTypes(chatflowId, workspaceId, permittedTypes)
        const appServer = getRunningExpressApp()
        const repo = appServer.AppDataSource.getRepository(ChatFlow)
        const chatflow = await repo.findOne({
            where: { id: chatflowId, workspaceId, type: permittedType },
            select: ['id', 'type', 'webhookSecret']
        })
        if (!chatflow) throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Chatflow changed concurrently')
        const result = await repo.update(
            {
                id: chatflowId,
                workspaceId,
                type: permittedType,
                webhookSecret: chatflow.webhookSecret == null ? IsNull() : chatflow.webhookSecret
            },
            { webhookSecret: null, webhookSecretConfigured: false }
        )
        if (result.affected !== 1) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Chatflow changed concurrently')
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.clearWebhookSecret - ${getErrorMessage(error)}`
        )
    }
}

const getWebhookSecret = async (chatflowId: string, workspaceId: string): Promise<string | null> => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(ChatFlow)
            .createQueryBuilder('chatflow')
            .select('chatflow.webhookSecret')
            .where('chatflow.id = :id', { id: chatflowId })
            .andWhere('chatflow.workspaceId = :workspaceId', { workspaceId })
            .getOne()
        const stored = dbResponse?.webhookSecret
        if (!stored) return null
        const decrypted = await decryptCredentialData(stored)
        return (decrypted?.secret as string | undefined) ?? null
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatflowsService.getWebhookSecret - ${getErrorMessage(error)}`
        )
    }
}

export default {
    assertChatflowIdsInWorkspace,
    checkIfChatflowIsValidForStreaming,
    checkIfChatflowIsValidForUploads,
    deleteChatflow,
    getAllChatflows,
    getAllChatflowsCount,
    getChatflowByApiKey,
    getChatflowById,
    getChatflowByIdForWorkspace,
    getChatflowByIdForWorkspaceAndTypes,
    assertChatflowInWorkspaceAndTypes,
    saveChatflow,
    updateChatflow,
    getSinglePublicChatbotConfig,
    checkIfChatflowHasChanged,
    getAllChatflowsCountByOrganization,
    setWebhookSecret,
    clearWebhookSecret,
    getWebhookSecret
}
