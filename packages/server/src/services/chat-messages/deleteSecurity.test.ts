import { removeFilesFromStorage } from 'flowise-components'
import { In } from 'typeorm'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { updateStorageUsage } from '../../utils/quotaUsage'

jest.mock('flowise-components', () => ({ removeFilesFromStorage: jest.fn() }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn() } }))
jest.mock('../../utils/quotaUsage', () => ({ updateStorageUsage: jest.fn() }))
jest.mock('../../utils/addChatMesage', () => ({ utilAddChatMessage: jest.fn() }))
jest.mock('../../utils/getChatMessage', () => ({ utilGetChatMessage: jest.fn() }))

import chatMessagesService from '.'

const mockRemoveFilesFromStorage = removeFilesFromStorage as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const mockUpdateStorageUsage = updateStorageUsage as jest.Mock

const chatMessageRepository = {
    findBy: jest.fn(),
    find: jest.fn(),
    delete: jest.fn()
}
const feedbackRepository = { find: jest.fn(), delete: jest.fn() }
const executionRepository = { delete: jest.fn() }

describe('chat message deletion service security', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository: (entity: unknown) => {
                    if (entity === ChatMessage) return chatMessageRepository
                    if (entity === ChatMessageFeedback) return feedbackRepository
                    if (entity === 'Execution') return executionRepository
                    throw new Error('unexpected repository')
                }
            }
        })
        mockRemoveFilesFromStorage.mockResolvedValue({ totalSize: 12 })
        mockUpdateStorageUsage.mockResolvedValue(undefined)
        chatMessageRepository.delete.mockResolvedValue({ affected: 2 })
        feedbackRepository.delete.mockResolvedValue({ affected: 2 })
        executionRepository.delete.mockResolvedValue({ affected: 1 })
    })

    it('re-resolves exact message IDs inside the authorized flow before scoped side effects', async () => {
        chatMessageRepository.findBy.mockResolvedValue([
            { id: 'message-1', chatflowid: 'flow-1', chatId: 'chat_with_under_score', executionId: 'execution-1' },
            { id: 'message-2', chatflowid: 'flow-1', chatId: 'chat_with_under_score', executionId: undefined }
        ])

        await expect(
            chatMessagesService.removeChatMessagesByMessageIds(
                'flow-1',
                ['message-1', 'message-2'],
                'organization-1',
                'workspace-1',
                {} as never
            )
        ).resolves.toEqual({ affected: 2 })

        expect(chatMessageRepository.findBy).toHaveBeenCalledWith({
            id: In(['message-1', 'message-2']),
            chatflowid: 'flow-1'
        })
        expect(feedbackRepository.delete).toHaveBeenCalledWith({
            chatflowid: 'flow-1',
            messageId: In(['message-1', 'message-2'])
        })
        expect(mockRemoveFilesFromStorage).toHaveBeenCalledTimes(1)
        expect(mockRemoveFilesFromStorage).toHaveBeenCalledWith('organization-1', 'flow-1', 'chat_with_under_score')
        expect(executionRepository.delete).toHaveBeenCalledWith({
            id: In(['execution-1']),
            agentflowId: 'flow-1',
            workspaceId: 'workspace-1'
        })
        expect(chatMessageRepository.delete).toHaveBeenCalledWith({
            id: In(['message-1', 'message-2']),
            chatflowid: 'flow-1'
        })
    })

    it('batches workspace-export relation reads below SQLite bind-variable limits', async () => {
        const flowIds = Array.from({ length: 1001 }, (_, index) => `flow-${index}`)
        chatMessageRepository.find.mockResolvedValue([])
        feedbackRepository.find.mockResolvedValue([])

        await expect(chatMessagesService.getMessagesByChatflowIds(flowIds)).resolves.toEqual([])
        await expect(chatMessagesService.getMessagesFeedbackByChatflowIds(flowIds)).resolves.toEqual([])

        expect(chatMessageRepository.find).toHaveBeenCalledTimes(3)
        expect(feedbackRepository.find).toHaveBeenCalledTimes(3)
        for (const [index, batch] of [flowIds.slice(0, 400), flowIds.slice(400, 800), flowIds.slice(800)].entries()) {
            expect(chatMessageRepository.find.mock.calls[index][0]).toEqual({
                where: { chatflowid: In(batch) },
                order: { id: 'ASC' },
                take: 10_001
            })
            expect(feedbackRepository.find.mock.calls[index][0]).toEqual({
                where: { chatflowid: In(batch) },
                order: { id: 'ASC' },
                take: 10_001
            })
        }
    })

    it('fails before materializing more than the workspace-export row cap', async () => {
        chatMessageRepository.find.mockResolvedValue(Array.from({ length: 10_001 }, (_, index) => ({ id: `message-${index}` })))

        await expect(chatMessagesService.getMessagesByChatflowIds(['flow-1'])).rejects.toMatchObject({ statusCode: 422 })
        expect(chatMessageRepository.find).toHaveBeenCalledWith({
            where: { chatflowid: In(['flow-1']) },
            order: { id: 'ASC' },
            take: 10_001
        })
    })

    it('fetches only exact feedback parent tuples in bounded batches', async () => {
        const references = Array.from({ length: 1001 }, (_, index) => ({
            messageId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            chatflowId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
        }))
        chatMessageRepository.find.mockResolvedValue([])

        await expect(chatMessagesService.getMessagesByReferencesForExport(references)).resolves.toEqual([])

        expect(chatMessageRepository.find).toHaveBeenCalledTimes(3)
        for (const [index, batch] of [references.slice(0, 400), references.slice(400, 800), references.slice(800)].entries()) {
            expect(chatMessageRepository.find.mock.calls[index][0]).toEqual({
                where: batch.map(({ messageId, chatflowId }) => ({ id: messageId, chatflowid: chatflowId })),
                order: { id: 'ASC' },
                take: 10_001
            })
        }
    })

    it('rejects malformed feedback parent references before querying', async () => {
        await expect(
            chatMessagesService.getMessagesByReferencesForExport([{ messageId: 'not-a-uuid', chatflowId: 'also-invalid' }])
        ).rejects.toMatchObject({ statusCode: 422 })
        expect(chatMessageRepository.find).not.toHaveBeenCalled()
    })

    it('fails before feedback, storage, execution, or message deletion if any ID leaves the authorized flow', async () => {
        chatMessageRepository.findBy.mockResolvedValue([{ id: 'message-1', chatflowid: 'flow-1', chatId: 'chat-1' }])

        await expect(
            chatMessagesService.removeChatMessagesByMessageIds(
                'flow-1',
                ['message-1', 'message-foreign'],
                'organization-1',
                'workspace-1',
                {} as never
            )
        ).rejects.toMatchObject({ statusCode: 409, message: 'Unable to delete chat messages' })

        expect(feedbackRepository.delete).not.toHaveBeenCalled()
        expect(mockRemoveFilesFromStorage).not.toHaveBeenCalled()
        expect(mockUpdateStorageUsage).not.toHaveBeenCalled()
        expect(executionRepository.delete).not.toHaveBeenCalled()
        expect(chatMessageRepository.delete).not.toHaveBeenCalled()
    })

    it('continues scoped DB deletion after a partial attachment cleanup failure and redacts the raw error', async () => {
        chatMessageRepository.findBy.mockResolvedValue([
            { id: 'message-1', chatflowid: 'flow-1', chatId: 'chat-1' },
            { id: 'message-2', chatflowid: 'flow-1', chatId: 'chat-2' }
        ])
        mockRemoveFilesFromStorage.mockResolvedValueOnce({ totalSize: 12 }).mockRejectedValueOnce(new Error('RAW_STORAGE_ERROR'))
        chatMessageRepository.delete.mockResolvedValueOnce({ affected: 2 })

        await expect(
            chatMessagesService.removeChatMessagesByMessageIds(
                'flow-1',
                ['message-1', 'message-2'],
                'organization-1',
                'workspace-1',
                {} as never
            )
        ).resolves.toEqual({ affected: 2 })

        expect(mockRemoveFilesFromStorage).toHaveBeenCalledTimes(2)
        expect(feedbackRepository.delete).toHaveBeenCalled()
        expect(chatMessageRepository.delete).toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledWith('[server]: Chat message attachment storage cleanup failed', { failedCount: 1 })
        expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('RAW_STORAGE_ERROR')
    })

    it('continues database deletion after irreversible storage deletion when usage accounting fails', async () => {
        chatMessageRepository.findBy.mockResolvedValue([{ id: 'message-1', chatflowid: 'flow-1', chatId: 'chat-1' }])
        mockUpdateStorageUsage.mockRejectedValueOnce(new Error('RAW_USAGE_ERROR'))
        chatMessageRepository.delete.mockResolvedValueOnce({ affected: 1 })

        await expect(
            chatMessagesService.removeChatMessagesByMessageIds('flow-1', ['message-1'], 'organization-1', 'workspace-1', {} as never)
        ).resolves.toEqual({ affected: 1 })
        expect(feedbackRepository.delete).toHaveBeenCalled()
        expect(chatMessageRepository.delete).toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledWith('[server]: Chat message attachment usage update failed', { failedCount: 1 })
        expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('RAW_USAGE_ERROR')
    })

    it('treats a confirmed missing attachment as an idempotent cleanup result', async () => {
        chatMessageRepository.findBy.mockResolvedValue([{ id: 'message-1', chatflowid: 'flow-1', chatId: 'chat-1' }])
        mockRemoveFilesFromStorage.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        chatMessageRepository.delete.mockResolvedValueOnce({ affected: 1 })

        await expect(
            chatMessagesService.removeChatMessagesByMessageIds('flow-1', ['message-1'], 'organization-1', 'workspace-1', {} as never)
        ).resolves.toEqual({ affected: 1 })

        expect(feedbackRepository.delete).toHaveBeenCalled()
        expect(chatMessageRepository.delete).toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledWith('[server]: Chat message attachment storage already missing', {
            idempotentMissingCount: 1
        })
    })
})
