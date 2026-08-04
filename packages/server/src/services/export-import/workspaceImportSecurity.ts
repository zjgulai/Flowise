import { StatusCodes } from 'http-status-codes'
import { type EntityManager, type EntityTarget, type ObjectLiteral } from 'typeorm'
import { validate as isUuid, v4 as uuidv4 } from 'uuid'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { CustomTemplate } from '../../database/entities/CustomTemplate'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { Execution } from '../../database/entities/Execution'
import { Tool } from '../../database/entities/Tool'
import { Variable } from '../../database/entities/Variable'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { type IComponentNodes, Platform } from '../../Interface'
import { assertAssistantCreationAllowed } from '../assistants/legacyPolicy'
import {
    extractFlowComponentsForImport,
    extractFlowComponentsFromListForImport,
    extractTypedFlowReferencesForImport,
    extractTypedFlowReferencesFromComponentListForImport,
    remapFlowReferencesForImport,
    remapFlowReferencesInComponentListForImport,
    transformComponentListInputsForImport,
    transformFlowComponentInputsForImport
} from './flowReferenceImport'
import { sanitizeWorkspaceExportWireData } from './workspaceExportSanitization'

export interface WorkspaceImportData {
    AgentFlow: ChatFlow[]
    AgentFlowV2: ChatFlow[]
    AssistantCustom: Assistant[]
    AssistantFlow: ChatFlow[]
    AssistantOpenAI: Assistant[]
    AssistantAzure: Assistant[]
    ChatFlow: ChatFlow[]
    ChatMessage: ChatMessage[]
    ChatMessageFeedback: ChatMessageFeedback[]
    CustomTemplate: CustomTemplate[]
    DocumentStore: DocumentStore[]
    DocumentStoreFileChunk: DocumentStoreFileChunk[]
    Execution: Execution[]
    Tool: Tool[]
    Variable: Variable[]
}

type JsonRecord = Record<string, unknown>

const MAX_COLLECTION_ITEMS = 10_000
const MAX_REFERENCE_LENGTH = 256
const MAX_IMPORT_JSON_DEPTH = 32
const MAX_IMPORT_JSON_NODES = 50_000
const MAX_IMPORT_JSON_BYTES = 5 * 1024 * 1024
const IMPORT_COLLECTIONS = [
    'AgentFlow',
    'AgentFlowV2',
    'AssistantCustom',
    'AssistantFlow',
    'AssistantOpenAI',
    'AssistantAzure',
    'ChatFlow',
    'ChatMessage',
    'ChatMessageFeedback',
    'CustomTemplate',
    'DocumentStore',
    'DocumentStoreFileChunk',
    'Execution',
    'Tool',
    'Variable'
] as const

const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)

const isPlainRecord = (value: unknown): value is JsonRecord => {
    if (!isRecord(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const invalidWorkspaceImport = (): never => {
    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid workspace import')
}

const assertWorkspaceImportBudget = (value: unknown): void => {
    const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
    const visitedObjects = new WeakSet<object>()
    let nodes = 0
    let bytes = 0
    while (stack.length > 0) {
        const current = stack.pop()!
        nodes += 1
        if (nodes > MAX_IMPORT_JSON_NODES || current.depth > MAX_IMPORT_JSON_DEPTH) invalidWorkspaceImport()
        if (typeof current.value === 'string') {
            bytes += Buffer.byteLength(current.value, 'utf8')
            if (bytes > MAX_IMPORT_JSON_BYTES || current.value.includes('\0')) invalidWorkspaceImport()
            continue
        }
        if (current.value === null || typeof current.value === 'boolean') continue
        if (typeof current.value === 'number') {
            if (!Number.isFinite(current.value)) invalidWorkspaceImport()
            continue
        }
        if (typeof current.value !== 'object') return invalidWorkspaceImport()
        const objectValue = current.value as object
        if (visitedObjects.has(objectValue)) return invalidWorkspaceImport()
        visitedObjects.add(objectValue)
        if (Array.isArray(objectValue)) {
            for (const entry of objectValue) stack.push({ value: entry, depth: current.depth + 1 })
            continue
        }
        if (!isPlainRecord(objectValue)) return invalidWorkspaceImport()
        for (const [key, entry] of Object.entries(objectValue)) {
            if (!key || key.length > MAX_REFERENCE_LENGTH || key === '__proto__' || key === 'prototype' || key === 'constructor') {
                invalidWorkspaceImport()
            }
            bytes += Buffer.byteLength(key, 'utf8')
            if (bytes > MAX_IMPORT_JSON_BYTES) invalidWorkspaceImport()
            stack.push({ value: entry, depth: current.depth + 1 })
        }
    }
}

const assertReferenceId = (value: unknown, requireUuid = true): string => {
    if (
        typeof value !== 'string' ||
        !value ||
        value !== value.trim() ||
        value.length > MAX_REFERENCE_LENGTH ||
        value.includes('\0') ||
        (requireUuid && !isUuid(value))
    ) {
        invalidWorkspaceImport()
    }
    return value as string
}

const parseJsonRecord = (value: unknown): JsonRecord => {
    if (typeof value !== 'string') invalidWorkspaceImport()
    let parsed: unknown
    try {
        parsed = JSON.parse(value as string)
    } catch {
        return invalidWorkspaceImport()
    }
    if (!isRecord(parsed)) invalidWorkspaceImport()
    assertWorkspaceImportBudget(parsed)
    return parsed as JsonRecord
}

const assertSerializedJsonBudget = (value: unknown): void => {
    if (typeof value !== 'string') invalidWorkspaceImport()
    const serialized = typeof value === 'string' ? value : invalidWorkspaceImport()
    let parsed: unknown
    try {
        parsed = JSON.parse(serialized)
    } catch {
        return invalidWorkspaceImport()
    }
    assertWorkspaceImportBudget(parsed)
}

const assertCollections = (value: unknown): WorkspaceImportData => {
    if (!isPlainRecord(value)) invalidWorkspaceImport()
    const source = { ...(value as JsonRecord) }
    for (const collectionName of IMPORT_COLLECTIONS) {
        const collection = source[collectionName]
        if (collection === undefined) source[collectionName] = []
        else if (!Array.isArray(collection) || collection.length > MAX_COLLECTION_ITEMS) invalidWorkspaceImport()
    }
    return source as unknown as WorkspaceImportData
}

/**
 * Treat every import source as hostile, including legacy files and direct API
 * callers. The export manifest is advisory only: credential references and
 * inline provider/MCP sensitive options are removed against the local component
 * catalog, while trusted endpoint and host targets may remain for portability
 * and require explicit review. Variable values always require rebinding.
 */
export const sanitizeWorkspaceImportForRebinding = (
    value: unknown,
    componentNodes: IComponentNodes,
    canonicalOrigin: string
): WorkspaceImportData => {
    try {
        assertWorkspaceImportBudget(value)
        const source = assertCollections(value)
        const sanitized = sanitizeWorkspaceExportWireData(source, componentNodes, canonicalOrigin)
        sanitized.Variable = sanitized.Variable.map((variable) => {
            if (!isPlainRecord(variable)) invalidWorkspaceImport()
            return { ...variable, value: '' } as Variable
        })
        return sanitized
    } catch {
        return invalidWorkspaceImport()
    }
}

const createFreshIdMap = (records: unknown[], seenSourceIds?: Set<string>): Map<string, string> => {
    const idMap = new Map<string, string>()
    for (const record of records) {
        if (!isRecord(record)) invalidWorkspaceImport()
        const recordObject = record as JsonRecord
        const sourceId = assertReferenceId(recordObject.id)
        if (idMap.has(sourceId) || seenSourceIds?.has(sourceId)) invalidWorkspaceImport()
        idMap.set(sourceId, uuidv4())
        seenSourceIds?.add(sourceId)
    }
    return idMap
}

const rewriteCustomToolReferences = (flowData: unknown, toolIdMap: ReadonlyMap<string, string>): string => {
    return transformFlowComponentInputsForImport(flowData, (component) => {
        if (component.name !== 'customTool') return undefined
        if (component.inputs.selectedTool === undefined || component.inputs.selectedTool === null || component.inputs.selectedTool === '') {
            return undefined
        }
        const selectedTool = assertReferenceId(component.inputs.selectedTool)
        const replacement = toolIdMap.get(selectedTool)
        return replacement ? { ...component.inputs, selectedTool: replacement } : undefined
    })
}

const remapCustomToolComponentInputs = (component: { name: string; inputs: JsonRecord }, toolIdMap: ReadonlyMap<string, string>) => {
    if (component.name !== 'customTool') return undefined
    const selectedTool = component.inputs.selectedTool
    if (selectedTool === undefined || selectedTool === null || selectedTool === '') return undefined
    const replacement = toolIdMap.get(assertReferenceId(selectedTool))
    return replacement ? { ...component.inputs, selectedTool: replacement } : undefined
}

const rewriteCustomAssistantDetails = (
    details: unknown,
    assistantFlowIdMap: ReadonlyMap<string, string>,
    usedFlowIds: Set<string>,
    flowIdMap: ReadonlyMap<string, string>,
    toolIdMap: ReadonlyMap<string, string>
): string => {
    const parsed = parseJsonRecord(details)
    if (parsed.flowId !== undefined && parsed.flowId !== null) {
        const sourceFlowId = assertReferenceId(parsed.flowId)
        const replacement = assistantFlowIdMap.get(sourceFlowId)
        if (!replacement) return invalidWorkspaceImport()
        if (usedFlowIds.has(replacement)) return invalidWorkspaceImport()
        usedFlowIds.add(replacement)
        parsed.flowId = replacement
    }
    if (parsed.tools !== undefined) {
        const flowRemappedTools = remapFlowReferencesInComponentListForImport(parsed.tools, flowIdMap)
        parsed.tools = transformComponentListInputsForImport(flowRemappedTools, (component) =>
            remapCustomToolComponentInputs(component, toolIdMap)
        )
    }
    return JSON.stringify(parsed)
}

const sanitizeImportedFlow = (
    source: ChatFlow,
    expectedType: EnumChatflowType,
    idMap: ReadonlyMap<string, string>,
    toolIdMap: ReadonlyMap<string, string>,
    workspaceId: string
): ChatFlow => {
    if (!isRecord(source) || source.type !== expectedType || typeof source.flowData !== 'string') invalidWorkspaceImport()
    assertSerializedJsonBudget(source.flowData)
    const sourceId = assertReferenceId(source.id)
    const remappedToolFlowData = rewriteCustomToolReferences(source.flowData, toolIdMap)
    return {
        id: idMap.get(sourceId)!,
        name: source.name,
        type: expectedType,
        flowData: remapFlowReferencesForImport(remappedToolFlowData, idMap),
        workspaceId,
        deployed: false,
        isPublic: false,
        webhookSecretConfigured: false,
        chatbotConfig: source.chatbotConfig,
        analytic: source.analytic,
        speechToText: source.speechToText,
        textToSpeech: source.textToSpeech,
        followUpPrompts: source.followUpPrompts,
        category: source.category,
        createdDate: source.createdDate,
        updatedDate: source.updatedDate
    } as ChatFlow
}

export const normalizeWorkspaceImportForCreate = (
    value: unknown,
    workspaceId: string,
    platform: Platform = Platform.OPEN_SOURCE
): WorkspaceImportData => {
    if (!workspaceId) invalidWorkspaceImport()
    assertWorkspaceImportBudget(value)
    const source = assertCollections(value)
    if (source.AssistantOpenAI.length > 0) assertAssistantCreationAllowed('OPENAI')
    if (source.AssistantAzure.length > 0) assertAssistantCreationAllowed('AZURE')
    if (platform === Platform.CLOUD && source.Variable.some((variable) => isRecord(variable) && variable.type === 'runtime')) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Cloud platform does not support runtime variables')
    }

    const flowSourceIds = new Set<string>()
    const flowIdMap = new Map<string, string>()
    for (const collection of [source.AgentFlow, source.AgentFlowV2, source.AssistantFlow, source.ChatFlow]) {
        for (const [sourceId, targetId] of createFreshIdMap(collection, flowSourceIds)) flowIdMap.set(sourceId, targetId)
    }
    const assistantFlowIdMap = new Map(
        source.AssistantFlow.map((flow) => {
            const sourceId = assertReferenceId(flow.id)
            return [sourceId, flowIdMap.get(sourceId)!] as const
        })
    )
    const usedAssistantFlowIds = new Set<string>()
    const assistantIdMap = createFreshIdMap(source.AssistantCustom)
    const templateIdMap = createFreshIdMap(source.CustomTemplate)
    const toolIdMap = createFreshIdMap(source.Tool)
    const executionIdMap = createFreshIdMap(source.Execution)
    const messageIdMap = createFreshIdMap(source.ChatMessage)
    const feedbackIdMap = createFreshIdMap(source.ChatMessageFeedback)
    const variableIdMap = createFreshIdMap(source.Variable)

    const data: WorkspaceImportData = {
        AgentFlow: source.AgentFlow.map((flow) =>
            sanitizeImportedFlow(flow, EnumChatflowType.MULTIAGENT, flowIdMap, toolIdMap, workspaceId)
        ),
        AgentFlowV2: source.AgentFlowV2.map((flow) =>
            sanitizeImportedFlow(flow, EnumChatflowType.AGENTFLOW, flowIdMap, toolIdMap, workspaceId)
        ),
        AssistantFlow: source.AssistantFlow.map((flow) =>
            sanitizeImportedFlow(flow, EnumChatflowType.ASSISTANT, flowIdMap, toolIdMap, workspaceId)
        ),
        ChatFlow: source.ChatFlow.map((flow) => sanitizeImportedFlow(flow, EnumChatflowType.CHATFLOW, flowIdMap, toolIdMap, workspaceId)),
        AssistantCustom: source.AssistantCustom.map((assistant) => {
            if (!isRecord(assistant) || assistant.type !== 'CUSTOM' || typeof assistant.details !== 'string') invalidWorkspaceImport()
            assertAssistantCreationAllowed(assistant.type)
            const sourceId = assertReferenceId(assistant.id)
            return {
                id: assistantIdMap.get(sourceId)!,
                credential: uuidv4(),
                details: rewriteCustomAssistantDetails(assistant.details, assistantFlowIdMap, usedAssistantFlowIds, flowIdMap, toolIdMap),
                iconSrc: assistant.iconSrc,
                type: 'CUSTOM',
                workspaceId,
                createdDate: assistant.createdDate,
                updatedDate: assistant.updatedDate
            } as Assistant
        }),
        AssistantOpenAI: [],
        AssistantAzure: [],
        ChatMessage: source.ChatMessage.map((message) => {
            if (!isRecord(message)) invalidWorkspaceImport()
            const sourceId = assertReferenceId(message.id)
            const sourceChatflowId = assertReferenceId(message.chatflowid)
            const sourceExecutionId =
                message.executionId === undefined || message.executionId === null ? undefined : assertReferenceId(message.executionId)
            return {
                id: messageIdMap.get(sourceId)!,
                role: message.role,
                chatflowid: flowIdMap.get(sourceChatflowId) ?? sourceChatflowId,
                ...(sourceExecutionId ? { executionId: executionIdMap.get(sourceExecutionId) ?? sourceExecutionId } : {}),
                content: message.content,
                sourceDocuments: message.sourceDocuments,
                usedTools: message.usedTools,
                fileAnnotations: message.fileAnnotations,
                agentReasoning: message.agentReasoning,
                reasonContent: message.reasonContent,
                fileUploads: message.fileUploads,
                artifacts: message.artifacts,
                action: message.action,
                chatType: message.chatType,
                chatId: message.chatId,
                memoryType: message.memoryType,
                sessionId: message.sessionId,
                leadEmail: message.leadEmail,
                followUpPrompts: message.followUpPrompts,
                createdDate: message.createdDate
            } as ChatMessage
        }),
        ChatMessageFeedback: source.ChatMessageFeedback.map((feedback) => {
            if (!isRecord(feedback)) invalidWorkspaceImport()
            const sourceId = assertReferenceId(feedback.id)
            const sourceChatflowId = assertReferenceId(feedback.chatflowid)
            const sourceMessageId = assertReferenceId(feedback.messageId)
            return {
                id: feedbackIdMap.get(sourceId)!,
                chatflowid: flowIdMap.get(sourceChatflowId) ?? sourceChatflowId,
                chatId: feedback.chatId,
                messageId: messageIdMap.get(sourceMessageId) ?? sourceMessageId,
                rating: feedback.rating,
                content: feedback.content,
                createdDate: feedback.createdDate
            } as ChatMessageFeedback
        }),
        CustomTemplate: source.CustomTemplate.map((template) => {
            if (!isRecord(template)) invalidWorkspaceImport()
            const templateRecord = template as unknown as JsonRecord
            const flowData =
                typeof templateRecord.flowData === 'string'
                    ? templateRecord.flowData
                    : templateRecord.type === 'Tool'
                    ? JSON.stringify({
                          iconSrc: templateRecord.iconSrc,
                          schema: templateRecord.schema,
                          func: templateRecord.func
                      })
                    : invalidWorkspaceImport()
            assertSerializedJsonBudget(flowData)
            const sourceId = assertReferenceId(template.id)
            return {
                id: templateIdMap.get(sourceId)!,
                name: template.name,
                flowData: remapFlowReferencesForImport(rewriteCustomToolReferences(flowData, toolIdMap), flowIdMap),
                description: template.description,
                badge: template.badge,
                framework: template.framework,
                usecases: template.usecases,
                type: template.type,
                workspaceId,
                createdDate: template.createdDate,
                updatedDate: template.updatedDate
            } as CustomTemplate
        }),
        DocumentStore: source.DocumentStore.map((store) => ({ ...store })),
        DocumentStoreFileChunk: source.DocumentStoreFileChunk.map((chunk) => ({ ...chunk })),
        Execution: source.Execution.map((execution) => {
            if (!isRecord(execution)) invalidWorkspaceImport()
            const sourceId = assertReferenceId(execution.id)
            const sourceFlowId = assertReferenceId(execution.agentflowId)
            return {
                id: executionIdMap.get(sourceId)!,
                executionData: execution.executionData,
                state: execution.state,
                agentflowId: flowIdMap.get(sourceFlowId) ?? sourceFlowId,
                sessionId: execution.sessionId,
                action: execution.action,
                isPublic: false,
                workspaceId,
                createdDate: execution.createdDate,
                updatedDate: execution.updatedDate,
                stoppedDate: execution.stoppedDate
            } as Execution
        }),
        Tool: source.Tool.map((tool) => {
            if (!isRecord(tool)) invalidWorkspaceImport()
            const sourceId = assertReferenceId(tool.id)
            return {
                id: toolIdMap.get(sourceId)!,
                name: tool.name,
                description: tool.description,
                color: tool.color,
                iconSrc: tool.iconSrc,
                schema: tool.schema,
                func: tool.func,
                workspaceId,
                createdDate: tool.createdDate,
                updatedDate: tool.updatedDate
            } as Tool
        }),
        Variable: source.Variable.map((variable) => {
            if (!isRecord(variable)) invalidWorkspaceImport()
            const sourceId = assertReferenceId(variable.id)
            return {
                id: variableIdMap.get(sourceId)!,
                name: variable.name,
                value: variable.value,
                type: variable.type,
                workspaceId,
                createdDate: variable.createdDate,
                updatedDate: variable.updatedDate
            } as Variable
        })
    }
    return data
}

const getImportedFlows = (data: WorkspaceImportData): ChatFlow[] => [
    ...data.AgentFlow,
    ...data.AgentFlowV2,
    ...data.AssistantFlow,
    ...data.ChatFlow
]

export const extractCustomToolIdsForImport = (flowData: string): string[] => {
    const ids = new Set<string>()
    for (const component of extractFlowComponentsForImport(flowData)) {
        if (component.name !== 'customTool') continue
        const selectedTool = component.inputs.selectedTool
        if (selectedTool === undefined || selectedTool === null || selectedTool === '') continue
        ids.add(assertReferenceId(selectedTool))
    }
    return [...ids]
}

const getAssistantFlowId = (assistant: Assistant): string | undefined => {
    const details = parseJsonRecord(assistant.details)
    if (details.flowId === undefined || details.flowId === null) return undefined
    return assertReferenceId(details.flowId)
}

const getAssistantTools = (assistant: Assistant): JsonRecord[] => {
    const details = parseJsonRecord(assistant.details)
    if (details.tools === undefined) return []
    if (!Array.isArray(details.tools)) invalidWorkspaceImport()
    const tools: unknown[] = Array.isArray(details.tools) ? details.tools : invalidWorkspaceImport()
    return tools.map((tool) => (isRecord(tool) ? (tool as JsonRecord) : invalidWorkspaceImport()))
}

export const preflightWorkspaceImportRelations = async (
    _manager: EntityManager,
    data: WorkspaceImportData,
    workspaceId: string
): Promise<void> => {
    if (!workspaceId) invalidWorkspaceImport()
    const importedFlows = getImportedFlows(data)
    const importedFlowById = new Map(importedFlows.map((flow) => [flow.id, flow]))
    const importedExecutionById = new Map(data.Execution.map((execution) => [execution.id, execution]))
    const importedMessageById = new Map(data.ChatMessage.map((message) => [message.id, message]))
    const importedToolIds = new Set(data.Tool.map((tool) => tool.id))

    const assistantFlowIds = data.AssistantCustom.map(getAssistantFlowId).filter((id): id is string => !!id)
    const assistantToolLists = data.AssistantCustom.map(getAssistantTools)
    const referencedFlowIds = new Set<string>([
        ...data.ChatMessage.map((message) => message.chatflowid),
        ...data.ChatMessageFeedback.map((feedback) => feedback.chatflowid),
        ...data.Execution.map((execution) => execution.agentflowId),
        ...[...importedFlows, ...data.CustomTemplate].flatMap((flow) =>
            extractTypedFlowReferencesForImport(flow.flowData).map((reference) => reference.targetId)
        ),
        ...assistantToolLists.flatMap((tools) =>
            extractTypedFlowReferencesFromComponentListForImport(tools).map((reference) => reference.targetId)
        )
    ])
    if ([...referencedFlowIds].some((id) => !importedFlowById.has(id))) invalidWorkspaceImport()

    const importedAssistantFlowIds = new Set(data.AssistantFlow.map((flow) => flow.id))
    if (new Set(assistantFlowIds).size !== assistantFlowIds.length) invalidWorkspaceImport()
    for (const flowId of assistantFlowIds) if (!importedAssistantFlowIds.has(flowId)) invalidWorkspaceImport()
    for (const execution of data.Execution) {
        if (!importedFlowById.has(execution.agentflowId)) invalidWorkspaceImport()
    }
    for (const message of data.ChatMessage) {
        if (!importedFlowById.has(message.chatflowid)) invalidWorkspaceImport()
    }
    for (const flow of [...importedFlows, ...data.CustomTemplate]) {
        for (const reference of extractTypedFlowReferencesForImport(flow.flowData)) {
            const target = importedFlowById.get(reference.targetId)
            if (!target || (reference.expectedType && target.type !== reference.expectedType)) invalidWorkspaceImport()
        }
    }
    for (const tools of assistantToolLists) {
        for (const reference of extractTypedFlowReferencesFromComponentListForImport(tools)) {
            const target = importedFlowById.get(reference.targetId)
            if (!target || (reference.expectedType && target.type !== reference.expectedType)) invalidWorkspaceImport()
        }
    }

    for (const message of data.ChatMessage) {
        if (!message.executionId) continue
        const execution = importedExecutionById.get(message.executionId)
        if (!execution || execution.agentflowId !== message.chatflowid) invalidWorkspaceImport()
    }

    const seenFeedbackMessageIds = new Set<string>()
    for (const feedback of data.ChatMessageFeedback) {
        const message = importedMessageById.get(feedback.messageId)
        if (
            !message ||
            message.chatflowid !== feedback.chatflowid ||
            message.chatId !== feedback.chatId ||
            seenFeedbackMessageIds.has(feedback.messageId)
        ) {
            invalidWorkspaceImport()
        }
        seenFeedbackMessageIds.add(feedback.messageId)
    }

    const toolReferenceIds = new Set<string>()
    for (const flow of [...importedFlows, ...data.CustomTemplate]) {
        for (const toolId of extractCustomToolIdsForImport(flow.flowData)) toolReferenceIds.add(toolId)
    }
    for (const tools of assistantToolLists) {
        for (const component of extractFlowComponentsFromListForImport(tools)) {
            if (component.name !== 'customTool') continue
            const selectedTool = component.inputs.selectedTool
            if (selectedTool === undefined || selectedTool === null || selectedTool === '') continue
            toolReferenceIds.add(assertReferenceId(selectedTool))
        }
    }
    if ([...toolReferenceIds].some((id) => !importedToolIds.has(id))) invalidWorkspaceImport()
}

export const insertWorkspaceImportBatch = async <T extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<T>,
    items: T[],
    batchSize = 900
): Promise<void> => {
    try {
        for (let index = 0; index < items.length; index += batchSize) {
            await manager.insert(entity, items.slice(index, index + batchSize))
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Workspace import changed concurrently')
    }
}
