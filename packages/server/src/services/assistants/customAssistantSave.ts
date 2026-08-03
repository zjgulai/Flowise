import { StatusCodes } from 'http-status-codes'
import { DataSource, EntityManager, In } from 'typeorm'
import { validate as validateUuid } from 'uuid'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { Credential } from '../../database/entities/Credential'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { Tool } from '../../database/entities/Tool'
import { WorkspaceShared } from '../../enterprise/database/entities/EnterpriseEntities'
import { Workspace } from '../../enterprise/database/entities/workspace.entity'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { IComponentNodes } from '../../Interface'
import { UsageCacheManager } from '../../UsageCacheManager'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { checkUsageLimit } from '../../utils/quotaUsage'
import { updateDocumentStoreUsageWithManager } from '../documentstore/documentStoreUsage'

type JsonRecord = Record<string, unknown>

export interface ExpectedAssistantSnapshot {
    updatedDate: string
    details: string
    type: 'CUSTOM'
}

export interface ExpectedChatflowSnapshot {
    id: string
    updatedDate: string
    name: string
    flowData: string
    type: typeof EnumChatflowType.ASSISTANT
}

export interface CustomAssistantSaveRequest {
    expectedAssistant: ExpectedAssistantSnapshot
    expectedChatflow: ExpectedChatflowSnapshot | null
    details: string
    flowData: string
}

export interface CustomAssistantSnapshotRequest {
    expectedAssistant: ExpectedAssistantSnapshot
    expectedChatflow: ExpectedChatflowSnapshot | null
}

export interface CustomAssistantSaveResult {
    assistant: Assistant
    chatflow: ChatFlow
    createdFlow: boolean
}

export interface CustomAssistantSaveDependencies {
    dataSource: DataSource
    usageCacheManager: UsageCacheManager
    componentNodes: IComponentNodes
    checkUsageLimitFn?: typeof checkUsageLimit
}

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const MAX_LEGACY_DOCUMENT_STORE_ID_LENGTH = 256

const badRequest = (message: string) => new InternalFlowiseError(StatusCodes.BAD_REQUEST, message)
const conflict = (message: string) => new InternalFlowiseError(StatusCodes.CONFLICT, message)

export const assertUuid: (value: unknown, fieldName: string) => void = (value, fieldName) => {
    if (!isNonEmptyString(value) || !validateUuid(value)) throw badRequest(`${fieldName} must be a valid UUID`)
}

const assertDocumentStoreId = (value: unknown, fieldName: string): void => {
    if (!isNonEmptyString(value) || value !== value.trim() || value.length > MAX_LEGACY_DOCUMENT_STORE_ID_LENGTH || value.includes('\0')) {
        throw badRequest(`${fieldName} must be a valid document store ID`)
    }
}

const parseJsonRecord = (serialized: unknown, fieldName: string): JsonRecord => {
    if (typeof serialized !== 'string' || serialized.length === 0) throw badRequest(`${fieldName} must be a non-empty JSON string`)
    let parsed: unknown
    try {
        parsed = JSON.parse(serialized)
    } catch {
        throw badRequest(`${fieldName} must be valid JSON`)
    }
    if (!isRecord(parsed)) throw badRequest(`${fieldName} must contain a JSON object`)
    return parsed
}

const assertSafeJsonTree = (root: unknown, fieldName: string) => {
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
    let visited = 0
    while (stack.length) {
        const current = stack.pop()!
        visited += 1
        if (visited > 100_000 || current.depth > 50) throw badRequest(`${fieldName} is too complex`)
        if (Array.isArray(current.value)) {
            for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 })
            continue
        }
        if (!isRecord(current.value)) continue
        for (const [key, value] of Object.entries(current.value)) {
            if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
                throw badRequest(`${fieldName} contains a forbidden key`)
            }
            stack.push({ value, depth: current.depth + 1 })
        }
    }
}

const assertComponent = (value: unknown, fieldName: string) => {
    if (!isRecord(value) || !isNonEmptyString(value.name)) throw badRequest(`${fieldName} must be an object with a name`)
    if (value.inputs !== undefined && !isRecord(value.inputs)) throw badRequest(`${fieldName}.inputs must be an object`)
    if (value.inputParams !== undefined) {
        if (!Array.isArray(value.inputParams)) throw badRequest(`${fieldName}.inputParams must be an array`)
        for (const [index, inputParam] of value.inputParams.entries()) {
            if (!isRecord(inputParam) || !isNonEmptyString(inputParam.name)) {
                throw badRequest(`${fieldName}.inputParams[${index}] must be an object with a name`)
            }
            if (
                inputParam.options !== undefined &&
                (!Array.isArray(inputParam.options) || inputParam.options.some((option) => typeof option !== 'string' && !isRecord(option)))
            ) {
                throw badRequest(`${fieldName}.inputParams[${index}].options must contain only strings or objects`)
            }
        }
    }
    if (value.credential !== undefined && value.credential !== null && value.credential !== '' && !isNonEmptyString(value.credential)) {
        throw badRequest(`${fieldName}.credential must be a non-empty string`)
    }
}

export const validateCustomAssistantDetails = (serializedDetails: unknown): JsonRecord => {
    const details = parseJsonRecord(serializedDetails, 'details')
    assertSafeJsonTree(details, 'details')
    if (
        typeof serializedDetails === 'string' &&
        (/data:[^;,]+(?:;[^;,=]+)*;base64,/i.test(serializedDetails) || serializedDetails.includes('FILE-STORAGE::'))
    ) {
        throw badRequest('details must not contain inline or stored file payloads')
    }
    if (!isNonEmptyString(details.name)) throw badRequest('details.name must be a non-empty string')
    assertComponent(details.chatModel, 'details.chatModel')
    if (typeof details.instruction !== 'string') throw badRequest('details.instruction must be a string')
    if (details.flowId !== undefined && details.flowId !== null && !isNonEmptyString(details.flowId)) {
        throw badRequest('details.flowId must be a non-empty string when provided')
    }
    if (details.flowId !== undefined && details.flowId !== null) assertUuid(details.flowId, 'details.flowId')
    if (!Array.isArray(details.documentStores)) throw badRequest('details.documentStores must be an array')
    for (const [index, store] of details.documentStores.entries()) {
        if (!isRecord(store) || !isNonEmptyString(store.id)) {
            throw badRequest(`details.documentStores[${index}] must be an object with an id`)
        }
        if (store.name !== undefined && typeof store.name !== 'string') {
            throw badRequest(`details.documentStores[${index}].name must be a string`)
        }
        if (store.description !== undefined && typeof store.description !== 'string') {
            throw badRequest(`details.documentStores[${index}].description must be a string`)
        }
        if (store.returnSourceDocuments !== undefined && typeof store.returnSourceDocuments !== 'boolean') {
            throw badRequest(`details.documentStores[${index}].returnSourceDocuments must be a boolean`)
        }
        assertDocumentStoreId(store.id, `details.documentStores[${index}].id`)
    }
    if (!Array.isArray(details.tools)) throw badRequest('details.tools must be an array')
    details.tools.forEach((tool, index) => assertComponent(tool, `details.tools[${index}]`))

    return {
        ...details,
        name: details.name.trim()
    }
}

export const validateCustomAssistantFlowData = (serializedFlowData: unknown): JsonRecord => {
    const flowData = parseJsonRecord(serializedFlowData, 'flowData')
    assertSafeJsonTree(flowData, 'flowData')
    if (!Array.isArray(flowData.nodes) || !Array.isArray(flowData.edges)) {
        throw badRequest('flowData.nodes and flowData.edges must be arrays')
    }
    if (typeof serializedFlowData === 'string' && /data:[^;,]+(?:;[^;,=]+)*;base64,/i.test(serializedFlowData)) {
        throw badRequest('flowData must not contain inline base64 files')
    }
    if (typeof serializedFlowData === 'string' && serializedFlowData.includes('FILE-STORAGE::')) {
        throw badRequest('flowData must not contain file-storage payloads')
    }

    const nodeIds = new Set<string>()
    for (const [index, node] of flowData.nodes.entries()) {
        if (!isRecord(node) || !isNonEmptyString(node.id) || !isRecord(node.data) || !isNonEmptyString(node.data.name)) {
            throw badRequest(`flowData.nodes[${index}] must include id and data.name`)
        }
        if (nodeIds.has(node.id)) throw badRequest(`flowData contains duplicate node id ${node.id}`)
        nodeIds.add(node.id)
        if (node.data.inputs !== undefined && !isRecord(node.data.inputs)) {
            throw badRequest(`flowData.nodes[${index}].data.inputs must be an object`)
        }
        if (node.data.category === 'Document Loaders') {
            throw badRequest('flowData must not contain document-loader file nodes')
        }
    }

    const edgeIds = new Set<string>()
    for (const [index, edge] of flowData.edges.entries()) {
        if (
            !isRecord(edge) ||
            !isNonEmptyString(edge.id) ||
            !isNonEmptyString(edge.source) ||
            !isNonEmptyString(edge.target) ||
            !nodeIds.has(edge.source) ||
            !nodeIds.has(edge.target)
        ) {
            throw badRequest(`flowData.edges[${index}] must connect existing nodes`)
        }
        if (edgeIds.has(edge.id)) throw badRequest(`flowData contains duplicate edge id ${edge.id}`)
        edgeIds.add(edge.id)
    }
    return flowData
}

const parseExpectedAssistant = (value: unknown): ExpectedAssistantSnapshot => {
    if (
        !isRecord(value) ||
        value.type !== 'CUSTOM' ||
        !isNonEmptyString(value.updatedDate) ||
        Number.isNaN(Date.parse(value.updatedDate)) ||
        typeof value.details !== 'string'
    ) {
        throw badRequest('expectedAssistant must contain updatedDate, details and type CUSTOM')
    }
    return value as unknown as ExpectedAssistantSnapshot
}

const parseExpectedChatflow = (value: unknown): ExpectedChatflowSnapshot | null => {
    if (value === null) return null
    if (
        !isRecord(value) ||
        value.type !== EnumChatflowType.ASSISTANT ||
        !isNonEmptyString(value.id) ||
        !isNonEmptyString(value.updatedDate) ||
        Number.isNaN(Date.parse(value.updatedDate)) ||
        !isNonEmptyString(value.name) ||
        typeof value.flowData !== 'string'
    ) {
        throw badRequest('expectedChatflow must be null or a complete ASSISTANT chatflow snapshot')
    }
    assertUuid(value.id, 'expectedChatflow.id')
    return value as unknown as ExpectedChatflowSnapshot
}

export const validateCustomAssistantSnapshotRequest = (value: unknown): CustomAssistantSnapshotRequest => {
    if (!isRecord(value)) throw badRequest('request body must be an object')
    if (!Object.prototype.hasOwnProperty.call(value, 'expectedAssistant')) {
        throw badRequest('expectedAssistant is required')
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'expectedChatflow')) {
        throw badRequest('expectedChatflow is required')
    }
    return {
        expectedAssistant: parseExpectedAssistant(value.expectedAssistant),
        expectedChatflow: parseExpectedChatflow(value.expectedChatflow)
    }
}

export const validateCustomAssistantSaveRequest = (
    value: unknown
): CustomAssistantSaveRequest & {
    parsedDetails: JsonRecord
    parsedFlowData: JsonRecord
} => {
    const { expectedAssistant, expectedChatflow } = validateCustomAssistantSnapshotRequest(value)
    const request = value as JsonRecord
    const parsedDetails = validateCustomAssistantDetails(request.details)
    const parsedFlowData = validateCustomAssistantFlowData(request.flowData)
    return {
        expectedAssistant,
        expectedChatflow,
        details: request.details as string,
        flowData: request.flowData as string,
        parsedDetails,
        parsedFlowData
    }
}

const assertAllowedCustomAssistantGraph = (details: JsonRecord, flowData: JsonRecord, componentNodes: IComponentNodes) => {
    const chatModel = details.chatModel as JsonRecord
    const chatModelName = chatModel.name as string
    const toolNames = new Set((details.tools as JsonRecord[]).map((tool) => tool.name as string))
    const fixedCategories: Record<string, string> = {
        bufferMemory: 'Memory',
        toolAgent: 'Agents',
        documentStoreVS: 'Vector Stores',
        retrieverTool: 'Tools'
    }
    const allowedNames = new Set([chatModelName, ...toolNames, ...Object.keys(fixedCategories)])
    const seenNames = new Set<string>()

    const assertCatalogCategory = (name: string, acceptedCategories: string[]) => {
        const component = componentNodes[name]
        if (!component || !acceptedCategories.includes(component.category)) {
            throw badRequest(`Component ${name} is unavailable for custom assistants`)
        }
    }
    assertCatalogCategory(chatModelName, ['Chat Models'])
    for (const toolName of toolNames) assertCatalogCategory(toolName, ['Tools', 'Tools (MCP)'])

    for (const node of flowData.nodes as JsonRecord[]) {
        const data = node.data as JsonRecord
        const name = data.name as string
        if (!allowedNames.has(name)) throw badRequest(`Component ${name} is not selected for this custom assistant`)
        if (name === chatModelName) assertCatalogCategory(name, ['Chat Models'])
        else if (toolNames.has(name)) assertCatalogCategory(name, ['Tools', 'Tools (MCP)'])
        else assertCatalogCategory(name, [fixedCategories[name]])
        seenNames.add(name)
    }

    if (!seenNames.has(chatModelName) || !seenNames.has('toolAgent')) {
        throw badRequest('flowData must contain the selected chat model and toolAgent')
    }
    for (const toolName of toolNames) {
        if (!seenNames.has(toolName)) throw badRequest(`flowData is missing selected tool ${toolName}`)
    }
}

const serializeDate = (value: Date | string): string => {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) throw conflict('Stored resource has an invalid updatedDate')
    return date.toISOString()
}

export const assertAssistantSnapshot = (assistant: Assistant, expected: ExpectedAssistantSnapshot) => {
    if (
        assistant.type !== 'CUSTOM' ||
        expected.type !== assistant.type ||
        assistant.details !== expected.details ||
        serializeDate(assistant.updatedDate) !== serializeDate(expected.updatedDate)
    ) {
        throw conflict('Assistant changed after it was loaded')
    }
}

export const extractPersistedFlowId = (serializedDetails: string): string | null => {
    const details = parseJsonRecord(serializedDetails, 'stored assistant details')
    if (details.flowId === undefined || details.flowId === null) return null
    if (!isNonEmptyString(details.flowId)) throw conflict('Stored assistant flowId is invalid')
    if (!validateUuid(details.flowId)) throw conflict('Stored assistant flowId is not a valid UUID')
    return details.flowId.trim()
}

export const assertExpectedFlowTarget = (flowId: string | null, expected: ExpectedChatflowSnapshot | null) => {
    if (flowId === null && expected !== null) throw conflict('Assistant does not have the expected linked flow')
    if (flowId !== null && (!expected || expected.id !== flowId)) throw conflict('Assistant linked flow changed after it was loaded')
}

export const assertChatflowSnapshot = (chatflow: ChatFlow, expected: ExpectedChatflowSnapshot) => {
    if (
        chatflow.id !== expected.id ||
        chatflow.type !== EnumChatflowType.ASSISTANT ||
        expected.type !== chatflow.type ||
        chatflow.name !== expected.name ||
        chatflow.flowData !== expected.flowData ||
        serializeDate(chatflow.updatedDate) !== serializeDate(expected.updatedDate)
    ) {
        throw conflict('Linked assistant flow changed after it was loaded')
    }
}

const collectOwnedResourceReferences = (details: JsonRecord, flowData: JsonRecord) => {
    const credentialIds = new Set<string>()
    const documentStoreIds = new Set<string>()
    const customToolIds = new Set<string>()
    const stack: unknown[] = [details, flowData]
    while (stack.length) {
        const value = stack.pop()
        if (Array.isArray(value)) {
            stack.push(...value)
            continue
        }
        if (!isRecord(value)) continue
        for (const [key, nested] of Object.entries(value)) {
            if (key === 'credential' || key === 'FLOWISE_CREDENTIAL_ID') {
                if (nested === undefined || nested === null || nested === '') continue
                if (!isNonEmptyString(nested)) throw badRequest(`${key} references must be non-empty strings`)
                assertUuid(nested, key)
                credentialIds.add(nested.trim())
            }
            stack.push(nested)
        }
    }

    for (const store of details.documentStores as JsonRecord[]) documentStoreIds.add((store.id as string).trim())
    for (const node of flowData.nodes as JsonRecord[]) {
        const data = node.data as JsonRecord
        if (data.name === 'customTool') {
            const inputs = data.inputs
            if (!isRecord(inputs) || !isNonEmptyString(inputs.selectedTool)) {
                throw badRequest(`customTool nodes must include inputs.selectedTool`)
            }
            assertUuid(inputs.selectedTool, 'customTool.inputs.selectedTool')
            for (const overrideName of ['customToolName', 'customToolDesc', 'customToolSchema', 'customToolFunc']) {
                if (inputs[overrideName] !== undefined && inputs[overrideName] !== null && inputs[overrideName] !== '') {
                    throw badRequest(`customTool.${overrideName} overrides are not allowed`)
                }
            }
            customToolIds.add(inputs.selectedTool.trim())
        }
        if (data.name !== 'documentStoreVS') continue
        const inputs = data.inputs
        if (!isRecord(inputs) || !isNonEmptyString(inputs.selectedStore)) {
            throw badRequest(`documentStoreVS nodes must include inputs.selectedStore`)
        }
        documentStoreIds.add(inputs.selectedStore.trim())
    }
    return { credentialIds, documentStoreIds, customToolIds }
}

const assertOwnedResources = async (manager: EntityManager, workspaceId: string, details: JsonRecord, flowData: JsonRecord) => {
    const references = collectOwnedResourceReferences(details, flowData)
    const { credentialIds, documentStoreIds, customToolIds } = references
    const credentialRepository = manager.getRepository(Credential)
    const sharedRepository = manager.getRepository(WorkspaceShared)
    for (const credentialId of credentialIds) {
        const owned = await credentialRepository.findOneBy({ id: credentialId, workspaceId })
        if (owned) continue
        const shared = await sharedRepository.count({ where: { workspaceId, sharedItemId: credentialId, itemType: 'credential' } })
        if (shared === 0) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Credential ${credentialId} not found`)
    }

    const documentStoreRepository = manager.getRepository(DocumentStore)
    for (const documentStoreId of documentStoreIds) {
        const store = await documentStoreRepository.findOneBy({ id: documentStoreId, workspaceId })
        if (!store) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store ${documentStoreId} not found`)
    }

    const toolRepository = manager.getRepository(Tool)
    for (const toolId of customToolIds) {
        const tool = await toolRepository.findOneBy({ id: toolId, workspaceId })
        if (!tool) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Tool ${toolId} not found`)
    }
    return references
}

const nextUpdatedDate = (previous: Date): Date => new Date(Math.max(Date.now(), previous.getTime() + 1))

const loadAssistantForSave = async (
    dataSource: DataSource,
    assistantId: string,
    workspaceId: string,
    expectedAssistant: ExpectedAssistantSnapshot,
    expectedChatflow: ExpectedChatflowSnapshot | null
) => {
    assertUuid(assistantId, 'assistantId')
    const assistant = await dataSource.getRepository(Assistant).findOneBy({ id: assistantId, workspaceId })
    if (!assistant) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Assistant ${assistantId} not found`)
    if (assistant.type !== 'CUSTOM') throw badRequest(`Assistant ${assistantId} is not a custom assistant`)
    assertAssistantSnapshot(assistant, expectedAssistant)
    const flowId = extractPersistedFlowId(assistant.details)
    assertExpectedFlowTarget(flowId, expectedChatflow)
    return { assistant, flowId }
}

const checkCreateQuota = async (dependencies: CustomAssistantSaveDependencies, organizationId: string, subscriptionId: string) => {
    const workspaceIds = (await dependencies.dataSource.getRepository(Workspace).findBy({ organizationId })).map(
        (workspace) => workspace.id
    )
    const currentUsage = workspaceIds.length
        ? await dependencies.dataSource.getRepository(ChatFlow).countBy({
              type: EnumChatflowType.ASSISTANT,
              workspaceId: In(workspaceIds)
          })
        : 0
    await (dependencies.checkUsageLimitFn ?? checkUsageLimit)('flows', subscriptionId, dependencies.usageCacheManager, currentUsage + 1)
}

export const saveCustomAssistantWithDependencies = async (
    assistantId: string,
    requestBody: unknown,
    organizationId: string,
    workspaceId: string,
    subscriptionId: string,
    dependencies: CustomAssistantSaveDependencies
): Promise<CustomAssistantSaveResult> => {
    const request = validateCustomAssistantSaveRequest(requestBody)
    assertAllowedCustomAssistantGraph(request.parsedDetails, request.parsedFlowData, dependencies.componentNodes)
    assertUuid(assistantId, 'assistantId')
    const activeWorkspace = await dependencies.dataSource.getRepository(Workspace).findOneBy({ id: workspaceId, organizationId })
    if (!activeWorkspace) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Workspace ${workspaceId} not found in organization ${organizationId}`)
    }
    const initial = await loadAssistantForSave(
        dependencies.dataSource,
        assistantId,
        workspaceId,
        request.expectedAssistant,
        request.expectedChatflow
    )
    if (!initial.flowId) await checkCreateQuota(dependencies, organizationId, subscriptionId)

    return dependencies.dataSource.transaction(async (manager) => {
        const transactionalWorkspace = await manager.getRepository(Workspace).findOneBy({ id: workspaceId, organizationId })
        if (!transactionalWorkspace) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Workspace ${workspaceId} not found in organization ${organizationId}`)
        }
        const assistantRepository = manager.getRepository(Assistant)
        const chatflowRepository = manager.getRepository(ChatFlow)
        const currentAssistant = await assistantRepository.findOneBy({ id: assistantId, workspaceId })
        if (!currentAssistant) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Assistant ${assistantId} not found`)
        if (currentAssistant.type !== 'CUSTOM') throw badRequest(`Assistant ${assistantId} is not a custom assistant`)
        assertAssistantSnapshot(currentAssistant, request.expectedAssistant)
        const currentFlowId = extractPersistedFlowId(currentAssistant.details)
        assertExpectedFlowTarget(currentFlowId, request.expectedChatflow)
        const ownedReferences = await assertOwnedResources(manager, workspaceId, request.parsedDetails, request.parsedFlowData)

        let chatflow: ChatFlow
        let createdFlow = false
        if (currentFlowId) {
            const currentChatflow = await chatflowRepository.findOneBy({ id: currentFlowId })
            if (
                !currentChatflow ||
                currentChatflow.workspaceId !== workspaceId ||
                currentChatflow.type !== EnumChatflowType.ASSISTANT ||
                !request.expectedChatflow
            ) {
                throw conflict('Linked assistant flow is missing or outside the active workspace')
            }
            assertChatflowSnapshot(currentChatflow, request.expectedChatflow)
            const flowUpdatedDate = nextUpdatedDate(currentChatflow.updatedDate)
            const flowUpdate = await chatflowRepository.update(
                {
                    id: currentChatflow.id,
                    workspaceId,
                    type: EnumChatflowType.ASSISTANT,
                    updatedDate: currentChatflow.updatedDate,
                    name: currentChatflow.name,
                    flowData: currentChatflow.flowData
                },
                {
                    name: request.parsedDetails.name as string,
                    flowData: request.flowData,
                    updatedDate: flowUpdatedDate
                }
            )
            if (flowUpdate.affected !== 1) throw conflict('Linked assistant flow was modified concurrently')
            chatflow = {
                ...currentChatflow,
                name: request.parsedDetails.name as string,
                flowData: request.flowData,
                updatedDate: flowUpdatedDate
            }
        } else {
            const newChatflow = chatflowRepository.create({
                name: request.parsedDetails.name as string,
                flowData: request.flowData,
                type: EnumChatflowType.ASSISTANT,
                workspaceId
            })
            chatflow = await chatflowRepository.save(newChatflow)
            createdFlow = true
        }

        const nextDetails = JSON.stringify({ ...request.parsedDetails, flowId: chatflow.id })
        const assistantUpdate = await assistantRepository.update(
            {
                id: currentAssistant.id,
                workspaceId,
                type: 'CUSTOM',
                updatedDate: currentAssistant.updatedDate,
                details: currentAssistant.details
            },
            {
                details: nextDetails,
                updatedDate: nextUpdatedDate(currentAssistant.updatedDate)
            }
        )
        if (assistantUpdate.affected !== 1) throw conflict('Assistant was modified concurrently')

        await updateDocumentStoreUsageWithManager(manager, chatflow.id, [...ownedReferences.documentStoreIds], workspaceId)

        const savedAssistant = await assistantRepository.findOneBy({ id: assistantId, workspaceId, type: 'CUSTOM' })
        const savedChatflow = await chatflowRepository.findOneBy({ id: chatflow.id, workspaceId, type: EnumChatflowType.ASSISTANT })
        if (!savedAssistant || !savedChatflow) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Atomic custom assistant save did not return both resources')
        }
        return { assistant: savedAssistant, chatflow: savedChatflow, createdFlow }
    })
}

export const saveCustomAssistant = async (
    assistantId: string,
    requestBody: unknown,
    organizationId: string,
    workspaceId: string,
    subscriptionId: string
): Promise<CustomAssistantSaveResult> => {
    try {
        const appServer = getRunningExpressApp()
        return await saveCustomAssistantWithDependencies(assistantId, requestBody, organizationId, workspaceId, subscriptionId, {
            dataSource: appServer.AppDataSource,
            usageCacheManager: appServer.usageCacheManager,
            componentNodes: appServer.nodesPool.componentNodes
        })
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: assistantsService.saveCustomAssistant - ${getErrorMessage(error)}`
        )
    }
}

export const getCustomAssistantFlowWithDataSource = async (
    assistantId: string,
    workspaceId: string,
    dataSource: DataSource
): Promise<ChatFlow | null> => {
    assertUuid(assistantId, 'assistantId')
    const assistant = await dataSource.getRepository(Assistant).findOneBy({ id: assistantId, workspaceId })
    if (!assistant) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Assistant ${assistantId} not found`)
    if (assistant.type !== 'CUSTOM') throw badRequest(`Assistant ${assistantId} is not a custom assistant`)
    const flowId = extractPersistedFlowId(assistant.details)
    if (!flowId) return null
    const chatflow = await dataSource.getRepository(ChatFlow).findOneBy({ id: flowId })
    if (!chatflow || chatflow.workspaceId !== workspaceId || chatflow.type !== EnumChatflowType.ASSISTANT) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Linked flow for assistant ${assistantId} not found`)
    }
    return chatflow
}

export const getCustomAssistantFlow = async (assistantId: string, workspaceId: string): Promise<ChatFlow | null> => {
    try {
        return await getCustomAssistantFlowWithDataSource(assistantId, workspaceId, getRunningExpressApp().AppDataSource)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: assistantsService.getCustomAssistantFlow - ${getErrorMessage(error)}`
        )
    }
}
