import { StatusCodes } from 'http-status-codes'
import { QueryRunner } from 'typeorm'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { CustomTemplate } from '../../database/entities/CustomTemplate'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { Execution } from '../../database/entities/Execution'
import { Tool } from '../../database/entities/Tool'
import { Variable } from '../../database/entities/Variable'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import assistantsService from '../assistants'
import chatflowService, { extractDocumentStoreIds } from '../chatflows'
import chatMessagesService from '../chat-messages'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import {
    applyDocumentStoreUsageReferencesForImport,
    extractCustomAssistantDocumentStoreUsageForImport,
    insertDocumentStoresForImport,
    insertDocumentStoreChunksForImport,
    mergeDocumentStoreUsageReferencesForImport,
    preflightDocumentStoreReferencesForImport,
    remapDocumentStoreIdsForImport,
    sanitizeDocumentStoresForImport
} from './documentStoreImport'
import {
    insertWorkspaceImportBatch,
    normalizeWorkspaceImportForCreate,
    preflightWorkspaceImportRelations,
    sanitizeWorkspaceImportForRebinding,
    type WorkspaceImportData
} from './workspaceImportSecurity'
import { utilGetChatMessage } from '../../utils/getChatMessage'
import { getStoragePath, parseJsonBody, resolveFlowiseRequestTarget } from 'flowise-components'
import path from 'path'
import { checkUsageLimit } from '../../utils/quotaUsage'
import documenStoreService from '../documentstore'
import executionService from '../executions'
import marketplacesService from '../marketplaces'
import toolsService from '../tools'
import variableService from '../variables'
import { ChatMessageRatingType, ChatType, Platform } from '../../Interface'
import logger from '../../utils/logger'
import { normalizeWorkspaceExportInput, type WorkspaceExportInput as ExportInput } from './workspaceExportContract'
import { buildWorkspaceExportClosure, type WorkspaceExportInventory } from './workspaceExportClosure'
import { createWorkspaceExportArtifact, type WorkspaceExportArtifact } from './workspaceExportPortability'

type ExportData = WorkspaceImportData

const convertExportInput = normalizeWorkspaceExportInput

const FileDefaultName = 'ExportData.json'

const unwrapCollection = <T>(value: T[] | { data: T[]; total: number }): T[] => ('data' in value ? value.data : value)

const exportData = async (
    exportInput: ExportInput,
    activeWorkspaceId: string
): Promise<{ FileDefaultName: string } & WorkspaceExportArtifact> => {
    try {
        const needsFlows =
            exportInput.agentflow ||
            exportInput.agentflowv2 ||
            exportInput.assistantCustom ||
            exportInput.chatflow ||
            exportInput.chat_message ||
            exportInput.chat_feedback ||
            exportInput.custom_template ||
            exportInput.execution
        const needsExecutableDependencies = needsFlows || exportInput.tool || exportInput.document_store
        const canonicalOrigin = resolveFlowiseRequestTarget().canonicalOrigin
        const flows = needsFlows ? unwrapCollection(await chatflowService.getAllChatflows(undefined, activeWorkspaceId)) : []
        const flowIds = flows.map((flow) => flow.id)

        const [assistants, messages, feedbacks, templates, documentStoresResult, fullExecutionsResult, toolsResult, variablesResult] =
            await Promise.all([
                exportInput.assistantCustom ? assistantsService.getAllAssistants(activeWorkspaceId, 'CUSTOM') : Promise.resolve([]),
                exportInput.chat_message
                    ? flowIds.length > 0
                        ? chatMessagesService.getMessagesByChatflowIds(flowIds)
                        : Promise.resolve([])
                    : Promise.resolve([]),
                exportInput.chat_feedback
                    ? flowIds.length > 0
                        ? chatMessagesService.getMessagesFeedbackByChatflowIds(flowIds)
                        : Promise.resolve([])
                    : Promise.resolve([]),
                exportInput.custom_template ? marketplacesService.getAllCustomTemplates(activeWorkspaceId) : Promise.resolve([]),
                needsFlows || exportInput.document_store
                    ? documenStoreService.getAllDocumentStores(activeWorkspaceId)
                    : Promise.resolve([]),
                exportInput.execution
                    ? executionService.getAllExecutions({ workspaceId: activeWorkspaceId, page: 1, limit: 10_000 })
                    : Promise.resolve({ data: [], total: 0 }),
                needsFlows || exportInput.tool ? toolsService.getAllTools(activeWorkspaceId) : Promise.resolve([]),
                needsExecutableDependencies || exportInput.variable
                    ? variableService.getAllVariables(activeWorkspaceId)
                    : Promise.resolve([])
            ])

        const feedbackParentMessages =
            exportInput.chat_feedback && !exportInput.chat_message
                ? await chatMessagesService.getMessagesByReferencesForExport(
                      feedbacks.map((feedback) => ({ messageId: feedback.messageId, chatflowId: feedback.chatflowid }))
                  )
                : []
        const closedMessages = exportInput.chat_message ? messages : feedbackParentMessages

        const executionsResult = exportInput.execution
            ? fullExecutionsResult
            : {
                  data: await executionService.getExecutionsByIdsForExport(
                      [
                          ...new Set(
                              closedMessages
                                  .map((message) => message.executionId)
                                  .filter((id): id is string => typeof id === 'string' && !!id)
                          )
                      ],
                      activeWorkspaceId
                  ),
                  total: 0
              }

        if (executionsResult.total > executionsResult.data.length) {
            throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '执行记录超过单次可恢复导出的安全上限，请缩小工作区后重试')
        }

        const inventory: WorkspaceExportInventory = {
            flows,
            assistants,
            messages: closedMessages,
            feedbacks,
            templates: (templates as CustomTemplate[]).filter((template) => template.workspaceId === activeWorkspaceId),
            documentStores: unwrapCollection(documentStoresResult as DocumentStore[] | { data: DocumentStore[]; total: number }),
            documentStoreChunks: [],
            executions: executionsResult.data.map((execution) => {
                const exported = { ...execution }
                Reflect.deleteProperty(exported, 'agentflow')
                return exported
            }),
            tools: unwrapCollection(toolsResult as Tool[] | { data: Tool[]; total: number }),
            variables: unwrapCollection(variablesResult as Variable[] | { data: Variable[]; total: number })
        }

        const preliminaryClosure = buildWorkspaceExportClosure(exportInput, inventory, canonicalOrigin)
        const documentStoreIds = preliminaryClosure.data.DocumentStore.map((documentStore) => documentStore.id)
        inventory.documentStoreChunks =
            documentStoreIds.length > 0
                ? await documenStoreService.getAllDocumentFileChunksByDocumentStoreIds(documentStoreIds)
                : ([] as DocumentStoreFileChunk[])
        const closure = buildWorkspaceExportClosure(exportInput, inventory, canonicalOrigin)
        const artifact = await createWorkspaceExportArtifact(
            closure.data,
            closure.manifest,
            getRunningExpressApp().nodesPool.componentNodes,
            canonicalOrigin,
            getRunningExpressApp().identityManager.getPlatformType() as Platform
        )
        return { FileDefaultName, ...artifact }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: exportImportService.exportData - ${getErrorMessage(error)}`
        )
    }
}

function replaceDuplicateIdsForDocumentStore(originalData: ExportData, documentStores: DocumentStore[]) {
    try {
        return remapDocumentStoreIdsForImport(
            originalData,
            documentStores.map((documentStore) => documentStore.id)
        ).data
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        logger.error('document_store_import_remap_failed', { failedCount: 1 })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store import failed')
    }
}

const importData = async (rawImportData: ExportData, orgId: string, activeWorkspaceId: string, subscriptionId: string) => {
    const appServer = getRunningExpressApp()
    const sanitizedImportData = sanitizeWorkspaceImportForRebinding(
        rawImportData,
        appServer.nodesPool.componentNodes,
        resolveFlowiseRequestTarget().canonicalOrigin
    )
    let importData = normalizeWorkspaceImportForCreate(
        sanitizedImportData,
        activeWorkspaceId,
        appServer.identityManager.getPlatformType() as Platform
    )
    let queryRunner: QueryRunner
    try {
        queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
        await queryRunner.connect()

        try {
            if (importData.AgentFlow.length > 0) {
                const existingChatflowCount = await chatflowService.getAllChatflowsCountByOrganization('MULTIAGENT', orgId)
                const newChatflowCount = importData.AgentFlow.length
                await checkUsageLimit(
                    'flows',
                    subscriptionId,
                    getRunningExpressApp().usageCacheManager,
                    existingChatflowCount + newChatflowCount
                )
            }
            if (importData.AgentFlowV2.length > 0) {
                const existingChatflowCount = await chatflowService.getAllChatflowsCountByOrganization('AGENTFLOW', orgId)
                const newChatflowCount = importData.AgentFlowV2.length
                await checkUsageLimit(
                    'flows',
                    subscriptionId,
                    getRunningExpressApp().usageCacheManager,
                    existingChatflowCount + newChatflowCount
                )
            }
            if (importData.AssistantCustom.length > 0) {
                const existingAssistantCount = await assistantsService.getAssistantsCountByOrganization('CUSTOM', orgId)
                const newAssistantCount = importData.AssistantCustom.length
                await checkUsageLimit(
                    'flows',
                    subscriptionId,
                    getRunningExpressApp().usageCacheManager,
                    existingAssistantCount + newAssistantCount
                )
            }
            if (importData.AssistantFlow.length > 0) {
                const existingChatflowCount = await chatflowService.getAllChatflowsCountByOrganization('ASSISTANT', orgId)
                const newChatflowCount = importData.AssistantFlow.length
                await checkUsageLimit(
                    'flows',
                    subscriptionId,
                    getRunningExpressApp().usageCacheManager,
                    existingChatflowCount + newChatflowCount
                )
            }
            if (importData.ChatFlow.length > 0) {
                const existingChatflowCount = await chatflowService.getAllChatflowsCountByOrganization('CHATFLOW', orgId)
                const newChatflowCount = importData.ChatFlow.length
                await checkUsageLimit(
                    'flows',
                    subscriptionId,
                    getRunningExpressApp().usageCacheManager,
                    existingChatflowCount + newChatflowCount
                )
            }
            if (importData.DocumentStore.length > 0 || importData.DocumentStoreFileChunk.length > 0) {
                importData.DocumentStore = sanitizeDocumentStoresForImport(
                    importData.DocumentStore.map((documentStore) => ({ ...documentStore, workspaceId: activeWorkspaceId }))
                )
                importData = replaceDuplicateIdsForDocumentStore(importData, importData.DocumentStore)
            }

            const importedFlows = [...importData.AgentFlow, ...importData.AgentFlowV2, ...importData.AssistantFlow, ...importData.ChatFlow]
            const usageReferences = mergeDocumentStoreUsageReferencesForImport([
                ...importedFlows.map((flow) => ({ id: flow.id, documentStoreIds: extractDocumentStoreIds(flow.flowData) })),
                ...extractCustomAssistantDocumentStoreUsageForImport(importData.AssistantCustom)
            ])
            const templateStoreIds = importData.CustomTemplate.flatMap((template) => extractDocumentStoreIds(template.flowData))

            await queryRunner.startTransaction()

            importData.DocumentStore = await preflightDocumentStoreReferencesForImport(
                queryRunner.manager,
                importData.DocumentStore,
                usageReferences,
                templateStoreIds,
                activeWorkspaceId
            )
            await preflightWorkspaceImportRelations(queryRunner.manager, importData, activeWorkspaceId)

            await insertWorkspaceImportBatch(queryRunner.manager, ChatFlow, importData.AgentFlow)
            await insertWorkspaceImportBatch(queryRunner.manager, ChatFlow, importData.AgentFlowV2)
            await insertWorkspaceImportBatch(queryRunner.manager, ChatFlow, importData.AssistantFlow)
            await insertWorkspaceImportBatch(queryRunner.manager, Assistant, importData.AssistantCustom)
            await insertWorkspaceImportBatch(queryRunner.manager, ChatFlow, importData.ChatFlow)
            await insertWorkspaceImportBatch(queryRunner.manager, ChatMessage, importData.ChatMessage)
            await insertWorkspaceImportBatch(queryRunner.manager, ChatMessageFeedback, importData.ChatMessageFeedback)
            await insertWorkspaceImportBatch(queryRunner.manager, CustomTemplate, importData.CustomTemplate)
            await insertDocumentStoresForImport(queryRunner.manager, importData.DocumentStore)
            await insertDocumentStoreChunksForImport(queryRunner.manager, importData.DocumentStoreFileChunk)
            await insertWorkspaceImportBatch(queryRunner.manager, Tool, importData.Tool)
            await insertWorkspaceImportBatch(queryRunner.manager, Execution, importData.Execution)
            await insertWorkspaceImportBatch(queryRunner.manager, Variable, importData.Variable)
            await applyDocumentStoreUsageReferencesForImport(
                queryRunner.manager,
                usageReferences,
                importData.DocumentStore.map((store) => store.id),
                activeWorkspaceId
            )

            await queryRunner.commitTransaction()
        } catch (error) {
            if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction()
            throw error
        } finally {
            if (!queryRunner.isReleased) await queryRunner.release()
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        logger.error('workspace_import_failed', { failedCount: 1 })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Workspace import failed')
    }
}

// Export chatflow messages
const exportChatflowMessages = async (
    chatflowId: string,
    chatType?: ChatType[] | string,
    feedbackType?: ChatMessageRatingType[] | string,
    startDate?: string,
    endDate?: string,
    workspaceId?: string
) => {
    try {
        // Parse chatType if it's a string
        let parsedChatTypes: ChatType[] | undefined
        if (chatType) {
            if (typeof chatType === 'string') {
                const parsed = parseJsonBody(chatType)
                parsedChatTypes = Array.isArray(parsed) ? parsed : [chatType as ChatType]
            } else if (Array.isArray(chatType)) {
                parsedChatTypes = chatType
            }
        }

        // Parse feedbackType if it's a string
        let parsedFeedbackTypes: ChatMessageRatingType[] | undefined
        if (feedbackType) {
            if (typeof feedbackType === 'string') {
                const parsed = parseJsonBody(feedbackType)
                parsedFeedbackTypes = Array.isArray(parsed) ? parsed : [feedbackType as ChatMessageRatingType]
            } else if (Array.isArray(feedbackType)) {
                parsedFeedbackTypes = feedbackType
            }
        }

        // Get all chat messages for the chatflow with feedback
        const chatMessages = await utilGetChatMessage({
            chatflowid: chatflowId,
            chatTypes: parsedChatTypes,
            feedbackTypes: parsedFeedbackTypes,
            startDate,
            endDate,
            sortOrder: 'DESC',
            feedback: true,
            activeWorkspaceId: workspaceId
        })

        const storagePath = getStoragePath()
        const exportObj: { [key: string]: any } = {}

        // Process each chat message
        for (const chatmsg of chatMessages) {
            const chatPK = getChatPK(chatmsg)
            const filePaths: string[] = []

            // Handle file uploads
            if (chatmsg.fileUploads) {
                const uploads = parseJsonBody(chatmsg.fileUploads)
                if (Array.isArray(uploads)) {
                    uploads.forEach((file: any) => {
                        if (file.type === 'stored-file') {
                            filePaths.push(path.join(storagePath, chatmsg.chatflowid, chatmsg.chatId, file.name))
                        }
                    })
                }
            }

            // Create message object
            const msg: any = {
                content: chatmsg.content,
                role: chatmsg.role === 'apiMessage' ? 'bot' : 'user',
                time: chatmsg.createdDate
            }

            // Add optional properties
            if (filePaths.length) msg.filePaths = filePaths
            if (chatmsg.sourceDocuments) msg.sourceDocuments = parseJsonBody(chatmsg.sourceDocuments)
            if (chatmsg.usedTools) msg.usedTools = parseJsonBody(chatmsg.usedTools)
            if (chatmsg.fileAnnotations) msg.fileAnnotations = parseJsonBody(chatmsg.fileAnnotations)
            if ((chatmsg as any).feedback) msg.feedback = (chatmsg as any).feedback.content
            if (chatmsg.agentReasoning) msg.agentReasoning = parseJsonBody(chatmsg.agentReasoning)

            // Handle artifacts
            if (chatmsg.artifacts) {
                const artifacts = parseJsonBody(chatmsg.artifacts)
                msg.artifacts = artifacts
                if (Array.isArray(artifacts)) {
                    artifacts.forEach((artifact: any) => {
                        if (artifact.type === 'png' || artifact.type === 'jpeg') {
                            const baseURL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`
                            artifact.data = `${baseURL}/api/v1/get-upload-file?chatflowId=${chatmsg.chatflowid}&chatId=${
                                chatmsg.chatId
                            }&fileName=${artifact.data.replace('FILE-STORAGE::', '')}`
                        }
                    })
                }
            }

            // Group messages by chat session
            if (!exportObj[chatPK]) {
                exportObj[chatPK] = {
                    id: chatmsg.chatId,
                    source: getChatType(chatmsg.chatType as ChatType),
                    sessionId: chatmsg.sessionId ?? null,
                    memoryType: chatmsg.memoryType ?? null,
                    email: (chatmsg as any).leadEmail ?? null,
                    messages: [msg]
                }
            } else {
                exportObj[chatPK].messages.push(msg)
            }
        }

        // Convert to array and reverse message order within each conversation
        const exportMessages = Object.values(exportObj).map((conversation: any) => ({
            ...conversation,
            messages: conversation.messages.reverse()
        }))

        return exportMessages
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: exportImportService.exportChatflowMessages - ${getErrorMessage(error)}`
        )
    }
}

// Helper function to get chat primary key
const getChatPK = (chatmsg: ChatMessage): string => {
    const chatId = chatmsg.chatId
    const memoryType = chatmsg.memoryType
    const sessionId = chatmsg.sessionId

    if (memoryType && sessionId) {
        return `${chatId}_${memoryType}_${sessionId}`
    }
    return chatId
}

// Helper function to get chat type display name
const getChatType = (chatType?: ChatType): string => {
    if (!chatType) return 'Unknown'

    switch (chatType) {
        case ChatType.EVALUATION:
            return 'Evaluation'
        case ChatType.INTERNAL:
            return 'UI'
        case ChatType.EXTERNAL:
            return 'API/Embed'
        case ChatType.MCP:
            return 'MCP'
        case ChatType.SCHEDULED:
            return 'Scheduled'
        case ChatType.WEBHOOK:
            return 'Webhook'
    }
}

export default {
    convertExportInput,
    exportData,
    importData,
    exportChatflowMessages
}
