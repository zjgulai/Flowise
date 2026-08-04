import { ChatMessageRatingType, ChatType } from '../Interface'
import { ChatFlow } from '../database/entities/ChatFlow'
import { ChatMessage } from '../database/entities/ChatMessage'
import { getRunningExpressApp } from './getRunningExpressApp'
import { utilGetChatMessage } from './getChatMessage'

jest.mock('./getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))

const WORKSPACE_ID = 'workspace-a'
const FLOW_ID = '00000000-0000-4000-8000-000000000001'

const message = (overrides: Record<string, unknown> = {}): ChatMessage =>
    ({
        id: '00000000-0000-4000-8000-000000000010',
        role: 'apiMessage',
        chatflowid: FLOW_ID,
        executionId: '00000000-0000-4000-8000-000000000020',
        content: 'answer',
        chatType: ChatType.INTERNAL,
        chatId: 'chat-a',
        sessionId: 'session-a',
        createdDate: new Date('2026-08-03T00:00:00.000Z'),
        ...overrides
    } as ChatMessage)

const queryBuilder = (rows: ChatMessage[]) => {
    const builder = {
        select: jest.fn(),
        leftJoinAndSelect: jest.fn(),
        leftJoinAndMapOne: jest.fn(),
        leftJoin: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        orderBy: jest.fn(),
        groupBy: jest.fn(),
        offset: jest.fn(),
        limit: jest.fn(),
        getMany: jest.fn().mockResolvedValue(rows),
        getRawMany: jest.fn().mockResolvedValue([])
    }

    for (const method of [
        builder.select,
        builder.leftJoinAndSelect,
        builder.leftJoinAndMapOne,
        builder.leftJoin,
        builder.where,
        builder.andWhere,
        builder.orderBy,
        builder.groupBy,
        builder.offset,
        builder.limit
    ]) {
        method.mockReturnValue(builder)
    }

    return builder
}

const installApp = (rows: ChatMessage[], builders = [queryBuilder(rows)]) => {
    const builder = builders.at(-1)!
    const findOneBy = jest.fn().mockResolvedValue({ id: FLOW_ID, workspaceId: WORKSPACE_ID })
    const createQueryBuilder = jest.fn()
    for (const candidate of builders) createQueryBuilder.mockReturnValueOnce(candidate)
    const getRepository = jest.fn((entity) => {
        if (entity === ChatFlow) return { findOneBy }
        if (entity === ChatMessage) return { createQueryBuilder }
        throw new Error('Unexpected repository')
    })

    jest.mocked(getRunningExpressApp).mockReturnValue({ AppDataSource: { getRepository } } as never)
    return { builder, createQueryBuilder, findOneBy, getRepository }
}

describe('utilGetChatMessage relation scope', () => {
    beforeEach(() => jest.clearAllMocks())

    it('fails closed before any repository read when the active workspace is missing', async () => {
        const getRepository = jest.fn()
        jest.mocked(getRunningExpressApp).mockReturnValue({ AppDataSource: { getRepository } } as never)

        await expect(utilGetChatMessage({ chatflowid: FLOW_ID })).rejects.toThrow('Unauthorized access')
        await expect(utilGetChatMessage({ chatflowid: FLOW_ID, activeWorkspaceId: '   ' })).rejects.toThrow('Unauthorized access')

        expect(getRunningExpressApp).not.toHaveBeenCalled()
        expect(getRepository).not.toHaveBeenCalled()
    })

    it('omits a poisoned execution relation whose parent is outside the message flow or active workspace', async () => {
        const poisoned = message({
            execution: {
                id: '00000000-0000-4000-8000-000000000020',
                agentflowId: '00000000-0000-4000-8000-000000000099',
                workspaceId: 'workspace-b'
            }
        })
        const { builder } = installApp([poisoned])

        const result = await utilGetChatMessage({ chatflowid: FLOW_ID, activeWorkspaceId: ` ${WORKSPACE_ID} ` })

        expect(result).toHaveLength(1)
        expect(result[0]).not.toHaveProperty('execution')
        expect(builder.leftJoinAndSelect).toHaveBeenCalledWith(
            'chat_message.execution',
            'execution',
            'execution.id = chat_message.executionId AND execution.agentflowId = chat_message.chatflowid AND execution.workspaceId = :activeWorkspaceId',
            { activeWorkspaceId: WORKSPACE_ID }
        )
    })

    it('retains a normal execution relation matching the message tuple and workspace', async () => {
        const ownedExecution = {
            id: '00000000-0000-4000-8000-000000000020',
            agentflowId: FLOW_ID,
            workspaceId: WORKSPACE_ID
        }
        installApp([message({ execution: ownedExecution })])

        const [result] = await utilGetChatMessage({ chatflowid: FLOW_ID, activeWorkspaceId: WORKSPACE_ID })

        expect(result.execution).toBe(ownedExecution)
    })

    it('omits poisoned feedback and execution while retaining normal scoped relations', async () => {
        const poisoned = message({
            id: '00000000-0000-4000-8000-000000000011',
            execution: {
                id: '00000000-0000-4000-8000-000000000020',
                agentflowId: FLOW_ID,
                workspaceId: 'workspace-b'
            },
            feedback: {
                id: '00000000-0000-4000-8000-000000000031',
                messageId: '00000000-0000-4000-8000-000000000011',
                chatflowid: '00000000-0000-4000-8000-000000000099',
                chatId: 'chat-a',
                rating: ChatMessageRatingType.THUMBS_DOWN
            }
        })
        const ownedExecution = {
            id: '00000000-0000-4000-8000-000000000021',
            agentflowId: FLOW_ID,
            workspaceId: WORKSPACE_ID
        }
        const ownedFeedback = {
            id: '00000000-0000-4000-8000-000000000032',
            messageId: '00000000-0000-4000-8000-000000000012',
            chatflowid: FLOW_ID,
            chatId: 'chat-a',
            rating: ChatMessageRatingType.THUMBS_UP
        }
        const normal = message({
            id: '00000000-0000-4000-8000-000000000012',
            executionId: ownedExecution.id,
            execution: ownedExecution,
            feedback: ownedFeedback
        })
        const { builder } = installApp([poisoned, normal])

        const result = await utilGetChatMessage({
            chatflowid: FLOW_ID,
            activeWorkspaceId: WORKSPACE_ID,
            feedback: true,
            messageId: normal.id
        })

        expect(result[0]).not.toHaveProperty('execution')
        expect(result[0]).not.toHaveProperty('feedback')
        expect(result[1]).toMatchObject({ execution: ownedExecution, feedback: ownedFeedback })
        expect(builder.leftJoinAndMapOne).toHaveBeenCalledWith(
            'chat_message.feedback',
            expect.any(Function),
            'feedback',
            'feedback.messageId = chat_message.id AND feedback.chatflowid = chat_message.chatflowid AND feedback.chatId = chat_message.chatId'
        )
    })

    it('uses the scoped feedback tuple in the paginated session prequery as well', async () => {
        const sessionBuilder = queryBuilder([])
        sessionBuilder.getRawMany.mockResolvedValue([{ sessionId: 'session-a' }])
        const messageBuilder = queryBuilder([message({ execution: undefined })])
        installApp([], [sessionBuilder, messageBuilder])

        await utilGetChatMessage({
            chatflowid: FLOW_ID,
            activeWorkspaceId: WORKSPACE_ID,
            feedback: true,
            feedbackTypes: [ChatMessageRatingType.THUMBS_DOWN],
            page: 1,
            pageSize: 10
        })

        expect(sessionBuilder.leftJoin).toHaveBeenCalledWith(
            expect.any(Function),
            'feedback',
            'feedback.messageId = chat_message.id AND feedback.chatflowid = chat_message.chatflowid AND feedback.chatId = chat_message.chatId'
        )
        expect(messageBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
            'chat_message.execution',
            'execution',
            'execution.id = chat_message.executionId AND execution.agentflowId = chat_message.chatflowid AND execution.workspaceId = :activeWorkspaceId',
            { activeWorkspaceId: WORKSPACE_ID }
        )
    })
})
