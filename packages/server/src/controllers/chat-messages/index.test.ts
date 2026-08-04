import { Request, Response } from 'express'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

const mockGetChatflowByIdForWorkspace = jest.fn()
const mockGetChatflowById = jest.fn()
const mockValidateFlowAPIKey = jest.fn()
const mockGetAllChatMessages = jest.fn()
const mockGetAllInternalChatMessages = jest.fn()
const mockRemoveChatMessagesByMessageIds = jest.fn()
const mockUtilGetChatMessage = jest.fn()
const mockClearSessionMemory = jest.fn()
const mockGetRunningExpressApp = jest.fn()
const mockLoggerWarn = jest.fn()
const mockAbortChatMessage = jest.fn()

jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowById: (...args: unknown[]) => mockGetChatflowById(...args),
        getChatflowByIdForWorkspace: (...args: unknown[]) => mockGetChatflowByIdForWorkspace(...args)
    }
}))

jest.mock('../../services/chat-messages', () => ({
    __esModule: true,
    default: {
        getAllChatMessages: (...args: unknown[]) => mockGetAllChatMessages(...args),
        getAllInternalChatMessages: (...args: unknown[]) => mockGetAllInternalChatMessages(...args),
        removeChatMessagesByMessageIds: (...args: unknown[]) => mockRemoveChatMessagesByMessageIds(...args),
        abortChatMessage: (...args: unknown[]) => mockAbortChatMessage(...args)
    }
}))

jest.mock('../../utils/getChatMessage', () => ({
    utilGetChatMessage: (...args: unknown[]) => mockUtilGetChatMessage(...args)
}))

jest.mock('../../utils', () => ({
    clearSessionMemory: (...args: unknown[]) => mockClearSessionMemory(...args)
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: (...args: unknown[]) => mockGetRunningExpressApp(...args)
}))

jest.mock('../../utils/pagination', () => ({ getPageAndLimitParams: () => ({ page: 1, limit: 20 }) }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: (...args: unknown[]) => mockLoggerWarn(...args) } }))
jest.mock('../../utils/validateKey', () => ({ validateFlowAPIKey: (...args: unknown[]) => mockValidateFlowAPIKey(...args) }))

import chatMessagesController from '.'

const createResponse = () => {
    const res = { json: jest.fn(), status: jest.fn(), send: jest.fn() }
    res.status.mockReturnValue(res)
    res.json.mockReturnValue(res)
    res.send.mockReturnValue(res)
    return res as unknown as Response
}

const createRequest = (overrides: Partial<Request> = {}): Request =>
    ({
        params: { id: 'flow-1' },
        query: {},
        user: {
            isOrganizationAdmin: false,
            permissions: [],
            activeOrganizationId: 'organization-1',
            activeWorkspaceId: 'workspace-1'
        },
        ...overrides
    } as unknown as Request)

const message = (overrides = {}) => ({
    id: 'message-1',
    chatflowid: 'flow-1',
    chatId: 'chat_with_under_score',
    memoryType: 'OpenAI_Assistant',
    sessionId: 'thread_with_under_score',
    ...overrides
})

describe('chat message authorization and deletion boundaries', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetChatflowByIdForWorkspace.mockResolvedValue({
            id: 'flow-1',
            workspaceId: 'workspace-1',
            type: EnumChatflowType.CHATFLOW,
            flowData: JSON.stringify({ nodes: [] })
        })
        mockGetChatflowById.mockResolvedValue({
            id: 'flow-1',
            workspaceId: 'workspace-1',
            type: EnumChatflowType.CHATFLOW,
            apikeyid: null
        })
        mockValidateFlowAPIKey.mockResolvedValue(true)
        mockAbortChatMessage.mockResolvedValue(undefined)
        mockGetAllChatMessages.mockResolvedValue([])
        mockGetAllInternalChatMessages.mockResolvedValue([])
        mockUtilGetChatMessage.mockResolvedValue([message()])
        mockRemoveChatMessagesByMessageIds.mockResolvedValue({ affected: 1 })
        mockClearSessionMemory.mockResolvedValue(undefined)
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            nodesPool: { componentNodes: {} },
            usageCacheManager: {}
        })
    })

    it('requires the view permission matching the stored flow type', async () => {
        mockGetChatflowByIdForWorkspace.mockResolvedValue({
            id: 'flow-1',
            workspaceId: 'workspace-1',
            type: EnumChatflowType.AGENTFLOW,
            flowData: JSON.stringify({ nodes: [] })
        })
        const denied = createRequest({ user: { ...createRequest().user!, permissions: ['chatflows:view'] } })
        const deniedNext = jest.fn()

        await chatMessagesController.getAllChatMessages(denied, createResponse(), deniedNext)

        expect(deniedNext.mock.calls[0][0]).toMatchObject({ statusCode: 403 })
        expect(mockGetAllChatMessages).not.toHaveBeenCalled()

        const allowed = createRequest({ user: { ...createRequest().user!, permissions: ['agentflows:view'] } })
        const allowedNext = jest.fn()
        await chatMessagesController.getAllChatMessages(allowed, createResponse(), allowedNext)

        expect(allowedNext).not.toHaveBeenCalled()
        expect(mockGetAllChatMessages).toHaveBeenCalledWith(
            'flow-1',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'workspace-1',
            1,
            20
        )
    })

    it('applies the same exact-type view authorization to internal messages', async () => {
        mockGetChatflowByIdForWorkspace.mockResolvedValue({
            id: 'flow-1',
            workspaceId: 'workspace-1',
            type: EnumChatflowType.ASSISTANT,
            flowData: JSON.stringify({ nodes: [] })
        })
        const req = createRequest({ user: { ...createRequest().user!, permissions: ['chatflows:view'] } })
        const next = jest.fn()

        await chatMessagesController.getAllInternalChatMessages(req, createResponse(), next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 })
        expect(mockGetAllInternalChatMessages).not.toHaveBeenCalled()
    })

    it('does not log raw malformed chat message metadata', async () => {
        mockGetAllChatMessages.mockResolvedValueOnce([
            message({ sourceDocuments: '{RAW_PRIVATE_METADATA', content: 'safe response', role: 'apiMessage' })
        ])
        const req = createRequest({ user: { ...createRequest().user!, permissions: ['chatflows:view'] } })

        await chatMessagesController.getAllChatMessages(req, createResponse(), jest.fn())

        expect(mockLoggerWarn).toHaveBeenCalledWith('[server]: Unable to parse chat message metadata')
        expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('RAW_PRIVATE_METADATA')
    })

    it('requires the delete permission matching the stored flow type', async () => {
        mockGetChatflowByIdForWorkspace.mockResolvedValue({
            id: 'flow-1',
            workspaceId: 'workspace-1',
            type: EnumChatflowType.AGENTFLOW,
            flowData: JSON.stringify({ nodes: [] })
        })
        const req = createRequest({ user: { ...createRequest().user!, permissions: ['chatflows:delete'] } })
        const next = jest.fn()

        await chatMessagesController.removeAllChatMessages(req, createResponse(), next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 })
        expect(mockUtilGetChatMessage).not.toHaveBeenCalled()
        expect(mockClearSessionMemory).not.toHaveBeenCalled()
        expect(mockRemoveChatMessagesByMessageIds).not.toHaveBeenCalled()
    })

    it('authorizes authenticated aborts against the persisted flow type and active workspace', async () => {
        const denied = createRequest({
            params: { chatflowid: 'flow-1', chatid: 'chat-1' },
            user: { ...createRequest().user!, permissions: ['agentflows:view'] }
        })
        const deniedNext = jest.fn()

        await chatMessagesController.abortChatMessage(denied, createResponse(), deniedNext)

        expect(deniedNext.mock.calls[0][0]).toMatchObject({ statusCode: 403 })
        expect(mockAbortChatMessage).not.toHaveBeenCalled()

        const allowed = createRequest({
            params: { chatflowid: 'flow-1', chatid: 'chat-1' },
            user: { ...createRequest().user!, permissions: ['chatflows:view'] }
        })
        await chatMessagesController.abortChatMessage(allowed, createResponse(), jest.fn())

        expect(mockGetChatflowByIdForWorkspace).toHaveBeenCalledWith('flow-1', 'workspace-1')
        expect(mockAbortChatMessage).toHaveBeenCalledWith('chat-1', 'flow-1')
    })

    it('rejects an anonymous abort with an invalid flow API key before publishing or aborting', async () => {
        mockValidateFlowAPIKey.mockResolvedValueOnce(false)
        const req = createRequest({
            params: { chatflowid: 'flow-1', chatid: 'chat-1' },
            user: undefined,
            headers: {}
        })
        const next = jest.fn()

        await chatMessagesController.abortChatMessage(req, createResponse(), next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401 })
        expect(mockValidateFlowAPIKey).toHaveBeenCalledWith(req, expect.objectContaining({ id: 'flow-1' }))
        expect(mockAbortChatMessage).not.toHaveBeenCalled()
    })

    it('fails a cross-workspace authenticated abort before publishing or aborting', async () => {
        mockGetChatflowByIdForWorkspace.mockRejectedValueOnce(new InternalFlowiseError(404, 'Chatflow not found'))
        const req = createRequest({
            params: { chatflowid: 'flow-other', chatid: 'chat-1' },
            user: { ...createRequest().user!, activeWorkspaceId: 'workspace-other', permissions: ['chatflows:view'] }
        })
        const next = jest.fn()

        await chatMessagesController.abortChatMessage(req, createResponse(), next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 })
        expect(mockAbortChatMessage).not.toHaveBeenCalled()
    })

    it('treats hardDelete=false as false and performs only the scoped local deletion', async () => {
        const req = createRequest({
            query: { hardDelete: 'false' },
            user: { ...createRequest().user!, permissions: ['chatflows:delete'] }
        })
        const next = jest.fn()

        await chatMessagesController.removeAllChatMessages(req, createResponse(), next)

        expect(next).not.toHaveBeenCalled()
        expect(mockClearSessionMemory).not.toHaveBeenCalled()
        expect(mockRemoveChatMessagesByMessageIds).toHaveBeenCalledWith('flow-1', ['message-1'], 'organization-1', 'workspace-1', {})
    })

    it('preserves underscore-bearing database values during an authorized hard delete', async () => {
        const req = createRequest({
            query: { hardDelete: 'true', isClearFromViewMessageDialog: 'false' },
            user: { ...createRequest().user!, permissions: ['chatflows:delete'] }
        })

        await chatMessagesController.removeAllChatMessages(req, createResponse(), jest.fn())

        expect(mockClearSessionMemory).toHaveBeenCalledWith(
            [],
            {},
            'chat_with_under_score',
            {},
            'organization-1',
            'thread_with_under_score',
            'OpenAI_Assistant',
            false,
            'workspace-1',
            'flow-1'
        )
    })

    it('rejects ambiguous hardDelete values before reading or deleting messages', async () => {
        const req = createRequest({
            query: { hardDelete: 'yes' },
            user: { ...createRequest().user!, permissions: ['chatflows:delete'] }
        })
        const next = jest.fn()

        await chatMessagesController.removeAllChatMessages(req, createResponse(), next)

        expect(next.mock.calls[0][0]).toEqual(expect.any(InternalFlowiseError))
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 })
        expect(mockUtilGetChatMessage).not.toHaveBeenCalled()
        expect(mockRemoveChatMessagesByMessageIds).not.toHaveBeenCalled()
    })

    it('derives a single-session Provider target from the scoped database message, not the query', async () => {
        const req = createRequest({
            query: { chatId: 'chat_with_under_score', sessionId: 'thread_attacker' },
            user: { ...createRequest().user!, permissions: ['chatflows:delete'] }
        })

        await chatMessagesController.removeAllChatMessages(req, createResponse(), jest.fn())

        expect(mockUtilGetChatMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'thread_attacker' }))
        expect(mockClearSessionMemory).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'chat_with_under_score',
            expect.anything(),
            'organization-1',
            'thread_with_under_score',
            'OpenAI_Assistant',
            false,
            'workspace-1',
            'flow-1'
        )
    })

    it('does not delete local evidence when third-party cleanup fails', async () => {
        mockClearSessionMemory.mockRejectedValueOnce(new Error('RAW_PROVIDER_ERROR'))
        const req = createRequest({
            query: { hardDelete: 'true' },
            user: { ...createRequest().user!, permissions: ['chatflows:delete'] }
        })
        const next = jest.fn()

        await chatMessagesController.removeAllChatMessages(req, createResponse(), next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(mockRemoveChatMessagesByMessageIds).not.toHaveBeenCalled()
    })
})
