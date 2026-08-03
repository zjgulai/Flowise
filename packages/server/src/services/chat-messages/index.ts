import { removeFilesFromStorage } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { DeleteResult, In } from 'typeorm'
import { validate as isUuid } from 'uuid'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { ChatMessageRatingType, ChatType, IChatMessage, MODE } from '../../Interface'
import { UsageCacheManager } from '../../UsageCacheManager'
import { utilAddChatMessage } from '../../utils/addChatMesage'
import { utilGetChatMessage } from '../../utils/getChatMessage'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { updateStorageUsage } from '../../utils/quotaUsage'

const isStorageNotFoundError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false
    const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown }
    return candidate.code === 'ENOENT' || candidate.status === StatusCodes.NOT_FOUND || candidate.statusCode === StatusCodes.NOT_FOUND
}

// Add chatmessages for chatflowid
const createChatMessage = async (chatMessage: Partial<IChatMessage>) => {
    try {
        const dbResponse = await utilAddChatMessage(chatMessage)
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatMessagesService.createChatMessage - ${getErrorMessage(error)}`
        )
    }
}

// Get all chatmessages from chatflowid
const getAllChatMessages = async (
    chatflowId: string,
    chatTypes: ChatType[] | undefined,
    sortOrder: string = 'ASC',
    chatId?: string,
    memoryType?: string,
    sessionId?: string,
    startDate?: string,
    endDate?: string,
    messageId?: string,
    feedback?: boolean,
    feedbackTypes?: ChatMessageRatingType[],
    activeWorkspaceId?: string,
    page?: number,
    pageSize?: number
): Promise<ChatMessage[]> => {
    try {
        const dbResponse = await utilGetChatMessage({
            chatflowid: chatflowId,
            chatTypes,
            sortOrder,
            chatId,
            memoryType,
            sessionId,
            startDate,
            endDate,
            messageId,
            feedback,
            feedbackTypes,
            activeWorkspaceId,
            page,
            pageSize
        })
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to get chat messages')
    }
}

// Get internal chatmessages from chatflowid
const getAllInternalChatMessages = async (
    chatflowId: string,
    chatTypes: ChatType[] | undefined,
    sortOrder: string = 'ASC',
    chatId?: string,
    memoryType?: string,
    sessionId?: string,
    startDate?: string,
    endDate?: string,
    messageId?: string,
    feedback?: boolean,
    feedbackTypes?: ChatMessageRatingType[],
    activeWorkspaceId?: string
): Promise<ChatMessage[]> => {
    try {
        const dbResponse = await utilGetChatMessage({
            chatflowid: chatflowId,
            chatTypes,
            sortOrder,
            chatId,
            memoryType,
            sessionId,
            startDate,
            endDate,
            messageId,
            feedback,
            feedbackTypes,
            activeWorkspaceId
        })
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to get internal chat messages')
    }
}

const removeChatMessagesByMessageIds = async (
    chatflowid: string,
    messageIds: string[],
    orgId: string,
    workspaceId: string,
    usageCacheManager: UsageCacheManager
): Promise<DeleteResult> => {
    try {
        const appServer = getRunningExpressApp()
        const uniqueMessageIds = [...new Set(messageIds)]
        if (uniqueMessageIds.length === 0) return { raw: [], affected: 0 }

        // Re-resolve every target inside the already-authorized flow before any side effect.
        const messages = await appServer.AppDataSource.getRepository(ChatMessage).findBy({ id: In(uniqueMessageIds), chatflowid })
        if (messages.length !== uniqueMessageIds.length) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Unable to delete chat messages')
        }
        const executionIds = [...new Set(messages.map((msg) => msg.executionId).filter((id): id is string => Boolean(id)))]

        let storageFailureCount = 0
        let idempotentMissingCount = 0
        let accountingFailureCount = 0
        for (const chatId of new Set(messages.map((message) => message.chatId))) {
            // Delete all uploads corresponding to this chatflow/chatId
            let totalSize: number
            try {
                ;({ totalSize } = await removeFilesFromStorage(orgId, chatflowid, chatId))
            } catch (error) {
                if (isStorageNotFoundError(error)) idempotentMissingCount += 1
                else storageFailureCount += 1
                continue
            }
            try {
                await updateStorageUsage(orgId, workspaceId, totalSize, usageCacheManager)
            } catch {
                accountingFailureCount += 1
            }
        }
        if (storageFailureCount > 0) {
            logger.error('[server]: Chat message attachment storage cleanup failed', { failedCount: storageFailureCount })
        }
        if (idempotentMissingCount > 0) {
            logger.warn('[server]: Chat message attachment storage already missing', { idempotentMissingCount })
        }
        if (accountingFailureCount > 0) {
            logger.error('[server]: Chat message attachment usage update failed', { failedCount: accountingFailureCount })
        }

        await appServer.AppDataSource.getRepository(ChatMessageFeedback).delete({
            chatflowid,
            messageId: In(uniqueMessageIds)
        })

        // Delete executions if they exist
        if (executionIds.length > 0) {
            await appServer.AppDataSource.getRepository('Execution').delete({
                id: In(executionIds),
                agentflowId: chatflowid,
                workspaceId
            })
        }

        const dbResponse = await appServer.AppDataSource.getRepository(ChatMessage).delete({ id: In(uniqueMessageIds), chatflowid })
        return dbResponse
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: chatMessagesService.removeChatMessagesByMessageIds - ${getErrorMessage(error)}`
        )
    }
}

const abortChatMessage = async (chatId: string, chatflowid: string) => {
    try {
        const appServer = getRunningExpressApp()
        if (!chatId || !chatflowid || chatId.length > 256 || chatflowid.length > 256) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid chat abort request')
        }
        const currentMessage = await appServer.AppDataSource.getRepository(ChatMessage).findOne({
            where: { chatflowid, chatId },
            order: { createdDate: 'DESC' }
        })
        if (!currentMessage) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Active chat was not found')
        const id = `${chatflowid}_${chatId}`

        if (process.env.MODE === MODE.QUEUE) {
            await appServer.queueManager.getPredictionQueueEventsProducer().publishEvent({
                eventName: 'abort',
                id
            })
        } else {
            if (!appServer.abortControllerPool.get(id)) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Chat execution is not active')
            }
            appServer.abortControllerPool.abort(id)
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to abort chat execution')
    }
}

const MAX_EXPORT_RELATION_QUERY_IDS = 400
const MAX_EXPORT_RELATION_ROWS = 10_000

const appendBoundedExportRows = <T>(target: T[], rows: T[]): void => {
    if (rows.length > MAX_EXPORT_RELATION_ROWS - target.length) {
        throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '工作区消息记录超过单次可恢复导出的安全上限')
    }
    target.push(...rows)
}

async function getMessagesByChatflowIds(chatflowIds: string[]): Promise<ChatMessage[]> {
    const appServer = getRunningExpressApp()
    const repository = appServer.AppDataSource.getRepository(ChatMessage)
    const messages: ChatMessage[] = []
    for (let index = 0; index < chatflowIds.length; index += MAX_EXPORT_RELATION_QUERY_IDS) {
        const batch = chatflowIds.slice(index, index + MAX_EXPORT_RELATION_QUERY_IDS)
        appendBoundedExportRows(
            messages,
            await repository.find({
                where: { chatflowid: In(batch) },
                order: { id: 'ASC' },
                take: MAX_EXPORT_RELATION_ROWS - messages.length + 1
            })
        )
    }
    return messages
}

interface ExportMessageReference {
    messageId: string
    chatflowId: string
}

async function getMessagesByReferencesForExport(references: ExportMessageReference[]): Promise<ChatMessage[]> {
    if (!Array.isArray(references) || references.length > MAX_EXPORT_RELATION_ROWS) {
        throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '工作区消息记录超过单次可恢复导出的安全上限')
    }
    const uniqueReferences = [
        ...new Map(
            references.map((reference) => [
                `${reference.messageId}:${reference.chatflowId}`,
                { messageId: reference.messageId, chatflowId: reference.chatflowId }
            ])
        ).values()
    ]
    if (uniqueReferences.some(({ messageId, chatflowId }) => !isUuid(messageId) || !isUuid(chatflowId))) {
        throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '消息反馈包含无效引用，无法导出')
    }

    const repository = getRunningExpressApp().AppDataSource.getRepository(ChatMessage)
    const messages: ChatMessage[] = []
    for (let index = 0; index < uniqueReferences.length; index += MAX_EXPORT_RELATION_QUERY_IDS) {
        const batch = uniqueReferences.slice(index, index + MAX_EXPORT_RELATION_QUERY_IDS)
        appendBoundedExportRows(
            messages,
            await repository.find({
                where: batch.map(({ messageId, chatflowId }) => ({ id: messageId, chatflowid: chatflowId })),
                order: { id: 'ASC' },
                take: MAX_EXPORT_RELATION_ROWS - messages.length + 1
            })
        )
    }
    return messages
}

async function getMessagesFeedbackByChatflowIds(chatflowIds: string[]): Promise<ChatMessageFeedback[]> {
    const appServer = getRunningExpressApp()
    const repository = appServer.AppDataSource.getRepository(ChatMessageFeedback)
    const feedbacks: ChatMessageFeedback[] = []
    for (let index = 0; index < chatflowIds.length; index += MAX_EXPORT_RELATION_QUERY_IDS) {
        const batch = chatflowIds.slice(index, index + MAX_EXPORT_RELATION_QUERY_IDS)
        appendBoundedExportRows(
            feedbacks,
            await repository.find({
                where: { chatflowid: In(batch) },
                order: { id: 'ASC' },
                take: MAX_EXPORT_RELATION_ROWS - feedbacks.length + 1
            })
        )
    }
    return feedbacks
}

export default {
    createChatMessage,
    getAllChatMessages,
    getAllInternalChatMessages,
    removeChatMessagesByMessageIds,
    abortChatMessage,
    getMessagesByChatflowIds,
    getMessagesByReferencesForExport,
    getMessagesFeedbackByChatflowIds
}
