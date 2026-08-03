import { StatusCodes } from 'http-status-codes'
import { validate as isUuid } from 'uuid'
import type { Assistant } from '../../database/entities/Assistant'
import type { ChatFlow } from '../../database/entities/ChatFlow'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import type { ChatMessage } from '../../database/entities/ChatMessage'
import type { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import type { CustomTemplate } from '../../database/entities/CustomTemplate'
import type { DocumentStore } from '../../database/entities/DocumentStore'
import type { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import type { Execution } from '../../database/entities/Execution'
import type { Tool } from '../../database/entities/Tool'
import type { Variable } from '../../database/entities/Variable'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { extractDocumentStoreIds } from '../chatflows'
import { extractCustomAssistantDocumentStoreUsageForImport } from './documentStoreImport'
import {
    extractFlowComponentsFromListForImport,
    extractTypedFlowReferencesForImport,
    extractTypedFlowReferencesFromComponentListForImport
} from './flowReferenceImport'
import type { WorkspaceExportInput } from './workspaceExportContract'
import type { WorkspaceExportManifest } from './workspaceExportPortability'
import { extractCustomToolIdsForImport, type WorkspaceImportData } from './workspaceImportSecurity'

export interface WorkspaceExportInventory {
    flows: ChatFlow[]
    assistants: Assistant[]
    messages: ChatMessage[]
    feedbacks: ChatMessageFeedback[]
    templates: CustomTemplate[]
    documentStores: DocumentStore[]
    documentStoreChunks: DocumentStoreFileChunk[]
    executions: Execution[]
    tools: Tool[]
    variables: Variable[]
}

export interface WorkspaceExportClosure {
    data: WorkspaceImportData
    manifest: WorkspaceExportManifest
}

const SELECTABLE_CATEGORIES: ReadonlyArray<keyof WorkspaceExportInput> = [
    'agentflow',
    'agentflowv2',
    'assistantCustom',
    'chatflow',
    'chat_message',
    'chat_feedback',
    'custom_template',
    'document_store',
    'execution',
    'tool',
    'variable'
]

const invalidExportClosure = (): never => {
    throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '工作区引用不完整，无法生成可恢复的导出文件')
}

const getRequiredId = (value: unknown): string =>
    typeof value === 'string' && value === value.trim() && isUuid(value) ? value : invalidExportClosure()

const getAssistantFlowId = (assistant: Assistant): string | undefined => {
    let details: unknown
    try {
        details = JSON.parse(assistant.details)
    } catch {
        return invalidExportClosure()
    }
    if (!details || typeof details !== 'object' || Array.isArray(details)) invalidExportClosure()
    const flowId = (details as Record<string, unknown>).flowId
    if (flowId === undefined || flowId === null) return undefined
    return getRequiredId(flowId)
}

const getAssistantTools = (assistant: Assistant): Record<string, unknown>[] => {
    let details: unknown
    try {
        details = JSON.parse(assistant.details)
    } catch {
        return invalidExportClosure()
    }
    if (!details || typeof details !== 'object' || Array.isArray(details)) invalidExportClosure()
    const tools = (details as Record<string, unknown>).tools
    if (tools === undefined) return []
    if (!Array.isArray(tools)) invalidExportClosure()
    const toolList: unknown[] = Array.isArray(tools) ? tools : invalidExportClosure()
    return toolList.map((tool) =>
        tool && typeof tool === 'object' && !Array.isArray(tool) ? (tool as Record<string, unknown>) : invalidExportClosure()
    )
}

const uniqueById = <T extends { id: string }>(items: T[]): Map<string, T> => {
    const result = new Map<string, T>()
    for (const item of items) {
        const id = getRequiredId(item.id)
        if (result.has(id)) invalidExportClosure()
        result.set(id, item)
    }
    return result
}

export const buildWorkspaceExportClosure = (
    input: WorkspaceExportInput,
    inventory: WorkspaceExportInventory,
    canonicalOrigin: string
): WorkspaceExportClosure => {
    const flowById = uniqueById(inventory.flows)
    const messageById = uniqueById(inventory.messages)
    const executionById = uniqueById(inventory.executions)
    const toolById = uniqueById(inventory.tools)
    const storeById = uniqueById(inventory.documentStores)

    const includedFlows = new Map<string, ChatFlow>()
    const pendingFlows: ChatFlow[] = []
    const includeFlow = (rawId: unknown, expectedType?: EnumChatflowType): void => {
        const id = getRequiredId(rawId)
        const flow = flowById.get(id) ?? invalidExportClosure()
        if (expectedType && flow.type !== expectedType) invalidExportClosure()
        if (includedFlows.has(id)) return
        includedFlows.set(id, flow)
        pendingFlows.push(flow)
    }

    for (const flow of inventory.flows) {
        if (
            (input.agentflow && flow.type === EnumChatflowType.MULTIAGENT) ||
            (input.agentflowv2 && flow.type === EnumChatflowType.AGENTFLOW) ||
            (input.chatflow && flow.type === EnumChatflowType.CHATFLOW)
        ) {
            includeFlow(flow.id)
        }
    }

    const assistants = input.assistantCustom ? inventory.assistants : []
    const assistantToolLists = assistants.map(getAssistantTools)
    for (const assistant of assistants) {
        const flowId = getAssistantFlowId(assistant)
        if (flowId) includeFlow(flowId, EnumChatflowType.ASSISTANT)
    }
    for (const tools of assistantToolLists) {
        for (const reference of extractTypedFlowReferencesFromComponentListForImport(tools, canonicalOrigin)) {
            includeFlow(reference.targetId, reference.expectedType as EnumChatflowType | undefined)
        }
    }

    const templates = input.custom_template ? inventory.templates : []
    for (const template of templates) {
        if (typeof template.flowData !== 'string') continue
        for (const reference of extractTypedFlowReferencesForImport(template.flowData, canonicalOrigin)) {
            includeFlow(reference.targetId, reference.expectedType as EnumChatflowType | undefined)
        }
    }
    const feedbacks = input.chat_feedback ? inventory.feedbacks : []
    const includedMessages = new Map<string, ChatMessage>()
    if (input.chat_message) {
        for (const message of inventory.messages) includedMessages.set(getRequiredId(message.id), message)
    }
    for (const feedback of feedbacks) {
        const messageId = getRequiredId(feedback.messageId)
        const message = messageById.get(messageId) ?? invalidExportClosure()
        if (getRequiredId(message.id) !== messageId || message.chatflowid !== feedback.chatflowid || message.chatId !== feedback.chatId) {
            invalidExportClosure()
        }
        includedMessages.set(messageId, message)
        includeFlow(feedback.chatflowid)
    }

    const includedExecutions = new Map<string, Execution>()
    if (input.execution) {
        for (const execution of inventory.executions) includedExecutions.set(getRequiredId(execution.id), execution)
    }
    for (const message of includedMessages.values()) {
        includeFlow(message.chatflowid)
        if (!message.executionId) continue
        const executionId = getRequiredId(message.executionId)
        const execution = executionById.get(executionId) ?? invalidExportClosure()
        if (getRequiredId(execution.agentflowId) !== getRequiredId(message.chatflowid)) invalidExportClosure()
        includedExecutions.set(executionId, execution)
    }
    for (const execution of includedExecutions.values()) includeFlow(execution.agentflowId)

    for (let cursor = 0; cursor < pendingFlows.length; cursor += 1) {
        const flow = pendingFlows[cursor]
        for (const reference of extractTypedFlowReferencesForImport(flow.flowData, canonicalOrigin)) {
            includeFlow(reference.targetId, reference.expectedType as EnumChatflowType | undefined)
        }
    }

    const flows = [...includedFlows.values()]
    const toolIds = new Set<string>()
    const documentStoreIds = new Set<string>()
    for (const flow of flows) {
        for (const toolId of extractCustomToolIdsForImport(flow.flowData)) toolIds.add(toolId)
        for (const storeId of extractDocumentStoreIds(flow.flowData)) documentStoreIds.add(storeId)
    }
    for (const template of templates) {
        if (typeof template.flowData !== 'string') continue
        for (const toolId of extractCustomToolIdsForImport(template.flowData)) toolIds.add(toolId)
        for (const storeId of extractDocumentStoreIds(template.flowData)) documentStoreIds.add(storeId)
    }
    for (const tools of assistantToolLists) {
        for (const component of extractFlowComponentsFromListForImport(tools)) {
            if (component.name !== 'customTool') continue
            const selectedTool = component.inputs.selectedTool
            if (selectedTool === undefined || selectedTool === null || selectedTool === '') continue
            toolIds.add(getRequiredId(selectedTool))
        }
    }
    for (const usage of extractCustomAssistantDocumentStoreUsageForImport(assistants)) {
        for (const storeId of usage.documentStoreIds) documentStoreIds.add(storeId)
    }

    const tools = input.tool ? inventory.tools : [...toolIds].map((id) => toolById.get(id) ?? invalidExportClosure())
    const documentStores = input.document_store
        ? inventory.documentStores
        : [...documentStoreIds].map((id) => storeById.get(id) ?? invalidExportClosure())
    const includedStoreIds = new Set(documentStores.map((store) => getRequiredId(store.id)))
    const documentStoreChunks = inventory.documentStoreChunks.filter((chunk) => includedStoreIds.has(getRequiredId(chunk.storeId)))
    const includeVariableDefinitions =
        input.variable || flows.length > 0 || assistants.length > 0 || templates.length > 0 || tools.length > 0 || documentStores.length > 0
    const variables = includeVariableDefinitions ? inventory.variables.map((variable) => ({ ...variable, value: '' })) : []

    const data: WorkspaceImportData = {
        AgentFlow: flows.filter((flow) => flow.type === EnumChatflowType.MULTIAGENT),
        AgentFlowV2: flows.filter((flow) => flow.type === EnumChatflowType.AGENTFLOW),
        AssistantCustom: assistants,
        AssistantFlow: flows.filter((flow) => flow.type === EnumChatflowType.ASSISTANT),
        AssistantOpenAI: [],
        AssistantAzure: [],
        ChatFlow: flows.filter((flow) => flow.type === EnumChatflowType.CHATFLOW),
        ChatMessage: [...includedMessages.values()],
        ChatMessageFeedback: feedbacks,
        CustomTemplate: templates,
        DocumentStore: documentStores,
        DocumentStoreFileChunk: documentStoreChunks,
        Execution: [...includedExecutions.values()],
        Tool: tools,
        Variable: variables
    }

    const manifest: WorkspaceExportManifest = {
        formatVersion: 1,
        dependencyMode: 'record-closure',
        selectedCategories: SELECTABLE_CATEGORIES.filter((category) => input[category]),
        includedDependencies: {
            flows: flows.length,
            tools: tools.length,
            documentStores: documentStores.length,
            variables: variables.length
        },
        rebindRequired: [
            'credentials',
            'variable-values',
            'mcp-connections',
            'api-key-and-rate-limit-policy',
            'provider-and-http-options',
            'local-file-and-directory-paths'
        ],
        reviewRequired: ['preserved-provider-and-http-targets'],
        restoreScope: 'structure-and-selected-user-content',
        contentWarning: 'contains-user-data-and-custom-code-review-before-sharing'
    }

    return { data, manifest }
}
