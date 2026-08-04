import { StatusCodes } from 'http-status-codes'

const mockChatflowsService = {
    assertChatflowInWorkspaceAndTypes: jest.fn(),
    getChatflowByIdForWorkspaceAndTypes: jest.fn(),
    getAllChatflows: jest.fn(),
    getAllChatflowsCountByOrganization: jest.fn(),
    saveChatflow: jest.fn(),
    updateChatflow: jest.fn(),
    getChatflowById: jest.fn(),
    getChatflowByApiKey: jest.fn(),
    deleteChatflow: jest.fn(),
    checkIfChatflowIsValidForStreaming: jest.fn(),
    checkIfChatflowIsValidForUploads: jest.fn(),
    getSinglePublicChatbotConfig: jest.fn(),
    checkIfChatflowHasChanged: jest.fn(),
    setWebhookSecret: jest.fn(),
    clearWebhookSecret: jest.fn()
}

const mockScheduleService = {
    getScheduleStatus: jest.fn(),
    getTriggerLogs: jest.fn(),
    deleteTriggerLogs: jest.fn(),
    toggleScheduleEnabled: jest.fn()
}

const mockCheckUsageLimit = jest.fn()
const mockUpdateRateLimiter = jest.fn()
const mockReadWorkspaceUserByUserId = jest.fn()

jest.mock('../../database/entities/ChatFlow', () => ({
    ChatFlow: class ChatFlow {},
    EnumChatflowType: { CHATFLOW: 'CHATFLOW', AGENTFLOW: 'AGENTFLOW', MULTIAGENT: 'MULTIAGENT', ASSISTANT: 'ASSISTANT' }
}))
jest.mock('../../services/chatflows', () => ({ __esModule: true, default: mockChatflowsService }))
jest.mock('../../services/schedule', () => ({ __esModule: true, default: mockScheduleService }))
jest.mock('../../services/apikey', () => ({ __esModule: true, default: { getApiKey: jest.fn() } }))
jest.mock('../../enterprise/services/workspace-user.service', () => ({
    WorkspaceUserErrorMessage: { WORKSPACE_USER_NOT_FOUND: 'not found' },
    WorkspaceUserService: class WorkspaceUserService {
        readWorkspaceUserByUserId = mockReadWorkspaceUserByUserId
    }
}))
jest.mock('../../schedule/ScheduleBeat', () => ({
    ScheduleBeat: { getInstance: () => ({ onScheduleChanged: jest.fn() }) }
}))
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        usageCacheManager: {},
        AppDataSource: { createQueryRunner: jest.fn() }
    })
}))
jest.mock('../../utils/pagination', () => ({ getPageAndLimitParams: () => ({ page: 1, limit: 20 }) }))
jest.mock('../../utils/quotaUsage', () => ({ checkUsageLimit: mockCheckUsageLimit }))
jest.mock('../../utils/rateLimit', () => ({
    RateLimiterManager: { getInstance: () => ({ updateRateLimiter: mockUpdateRateLimiter }) }
}))
jest.mock('../../utils/sanitizeFlowData', () => ({ sanitizeFlowDataForPublicEndpoint: (value: unknown) => value }))

import { EnumChatflowType } from '../../database/entities/ChatFlow'
import chatflowsController from './index'

const createResponse = () => {
    const response = {
        status: jest.fn(),
        json: jest.fn(),
        send: jest.fn(),
        sendStatus: jest.fn()
    }
    response.status.mockReturnValue(response)
    response.json.mockReturnValue(response)
    response.send.mockReturnValue(response)
    response.sendStatus.mockReturnValue(response)
    return response
}

const createRequest = (overrides: Record<string, unknown> = {}) =>
    ({
        params: {},
        query: {},
        body: {},
        user: {
            activeWorkspaceId: 'workspace-1',
            activeOrganizationId: 'organization-1',
            activeOrganizationSubscriptionId: 'subscription-1',
            isOrganizationAdmin: false,
            permissions: []
        },
        ...overrides
    } as any)

describe('chatflowsController type-aware RBAC', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockChatflowsService.getAllChatflows.mockResolvedValue({ data: [], total: 0 })
        mockChatflowsService.getAllChatflowsCountByOrganization.mockResolvedValue(0)
        mockChatflowsService.saveChatflow.mockImplementation(async (flow) => flow)
        mockChatflowsService.updateChatflow.mockImplementation(async (_current, update) => update)
        mockChatflowsService.assertChatflowInWorkspaceAndTypes.mockResolvedValue(EnumChatflowType.CHATFLOW)
        mockReadWorkspaceUserByUserId.mockResolvedValue([])
        mockCheckUsageLimit.mockResolvedValue(undefined)
        mockUpdateRateLimiter.mockResolvedValue(undefined)
    })

    it('filters the generic list to only Chatflow records for a chatflows:view user', async () => {
        const request = createRequest({
            user: { ...createRequest().user, permissions: ['chatflows:view'] }
        })
        const response = createResponse()
        const next = jest.fn()

        await chatflowsController.getAllChatflows(request, response as any, next)

        expect(mockChatflowsService.getAllChatflows).toHaveBeenCalledWith(
            undefined,
            'workspace-1',
            1,
            20,
            undefined,
            undefined,
            undefined,
            [EnumChatflowType.CHATFLOW]
        )
        expect(next).not.toHaveBeenCalled()
    })

    it('maps agentflows:view to both Agentflow generations', async () => {
        const request = createRequest({
            user: { ...createRequest().user, permissions: ['agentflows:view'] }
        })

        await chatflowsController.getAllChatflows(request, createResponse() as any, jest.fn())

        expect(mockChatflowsService.getAllChatflows).toHaveBeenCalledWith(
            undefined,
            'workspace-1',
            1,
            20,
            undefined,
            undefined,
            undefined,
            [EnumChatflowType.AGENTFLOW, EnumChatflowType.MULTIAGENT]
        )
    })

    it('rejects a requested cross-type list before service access', async () => {
        const request = createRequest({
            query: { type: EnumChatflowType.AGENTFLOW },
            user: { ...createRequest().user, permissions: ['chatflows:view'] }
        })
        const next = jest.fn()

        await chatflowsController.getAllChatflows(request, createResponse() as any, next)

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN }))
        expect(mockChatflowsService.getAllChatflows).not.toHaveBeenCalled()
    })

    it('rejects Assistant from an organization-admin generic list', async () => {
        const request = createRequest({
            query: { type: EnumChatflowType.ASSISTANT },
            user: { ...createRequest().user, isOrganizationAdmin: true }
        })
        const next = jest.fn()

        await chatflowsController.getAllChatflows(request, createResponse() as any, next)

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN }))
        expect(mockChatflowsService.getAllChatflows).not.toHaveBeenCalled()
    })

    it('passes only the type scope granted for a private by-id read', async () => {
        const flow = { id: 'flow-1', type: EnumChatflowType.CHATFLOW }
        mockChatflowsService.getChatflowByIdForWorkspaceAndTypes.mockResolvedValue(flow)
        const request = createRequest({
            params: { id: 'flow-1' },
            user: { ...createRequest().user, permissions: ['chatflows:view'] }
        })
        const response = createResponse()

        await chatflowsController.getChatflowById(request, response as any, jest.fn())

        expect(mockChatflowsService.getChatflowByIdForWorkspaceAndTypes).toHaveBeenCalledWith('flow-1', 'workspace-1', [
            EnumChatflowType.CHATFLOW
        ])
        expect(response.json).toHaveBeenCalledWith(flow)
    })

    it('rejects cross-type creation before quota lookup or persistence', async () => {
        const request = createRequest({
            body: { type: EnumChatflowType.AGENTFLOW, name: 'blocked', flowData: '{}' },
            user: { ...createRequest().user, permissions: ['chatflows:create'] }
        })
        const next = jest.fn()

        await chatflowsController.saveChatflow(request, createResponse() as any, next)

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN }))
        expect(mockChatflowsService.getAllChatflowsCountByOrganization).not.toHaveBeenCalled()
        expect(mockCheckUsageLimit).not.toHaveBeenCalled()
        expect(mockChatflowsService.saveChatflow).not.toHaveBeenCalled()
    })

    it('strips MCP and webhook server state from generic create input', async () => {
        const request = createRequest({
            body: {
                type: EnumChatflowType.CHATFLOW,
                name: 'safe',
                flowData: '{}',
                mcpServerConfig: '{"token":"attacker"}',
                webhookSecret: 'attacker',
                webhookSecretConfigured: true
            },
            user: { ...createRequest().user, permissions: ['chatflows:create'] }
        })

        await chatflowsController.saveChatflow(request, createResponse() as any, jest.fn())

        const savedInput = mockChatflowsService.saveChatflow.mock.calls[0][0]
        expect(savedInput).not.toHaveProperty('mcpServerConfig')
        expect(savedInput).not.toHaveProperty('webhookSecret')
        expect(savedInput).not.toHaveProperty('webhookSecretConfigured')
    })

    it('rejects a cross-type update before rate-limiter or persistence writes', async () => {
        mockChatflowsService.getChatflowByIdForWorkspaceAndTypes.mockResolvedValue({
            id: 'flow-1',
            type: EnumChatflowType.CHATFLOW
        })
        const request = createRequest({
            params: { id: 'flow-1' },
            body: { type: EnumChatflowType.AGENTFLOW, name: 'blocked' },
            user: { ...createRequest().user, permissions: ['chatflows:update', 'agentflows:update'] }
        })
        const next = jest.fn()

        await chatflowsController.updateChatflow(request, createResponse() as any, next)

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN }))
        expect(mockUpdateRateLimiter).not.toHaveBeenCalled()
        expect(mockChatflowsService.updateChatflow).not.toHaveBeenCalled()
    })

    it('checks the actual type scope before writing webhook server state', async () => {
        mockChatflowsService.assertChatflowInWorkspaceAndTypes.mockRejectedValue(
            Object.assign(new Error('forbidden'), { statusCode: StatusCodes.FORBIDDEN })
        )
        const request = createRequest({
            params: { id: 'flow-1' },
            user: { ...createRequest().user, permissions: ['chatflows:update'] }
        })
        const next = jest.fn()

        await chatflowsController.setWebhookSecret(request, createResponse() as any, next)

        expect(mockChatflowsService.assertChatflowInWorkspaceAndTypes).toHaveBeenCalledWith('flow-1', 'workspace-1', [
            EnumChatflowType.CHATFLOW
        ])
        expect(mockChatflowsService.setWebhookSecret).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN }))
    })

    it('hides Assistant records from the generic public-flow endpoint', async () => {
        mockChatflowsService.getChatflowById.mockResolvedValue({ id: 'assistant-1', type: EnumChatflowType.ASSISTANT, isPublic: true })
        const response = createResponse()

        await chatflowsController.getSinglePublicChatflow(
            createRequest({ params: { id: 'assistant-1' }, user: undefined }),
            response as any,
            jest.fn()
        )

        expect(response.status).toHaveBeenCalledWith(StatusCodes.NOT_FOUND)
        expect(response.json).toHaveBeenCalledWith({ message: 'Chatflow not found' })
    })

    it('does not expose a private Agentflow through the public endpoint to a Chatflow-only workspace member', async () => {
        mockChatflowsService.getChatflowById.mockResolvedValue({
            id: 'agentflow-1',
            workspaceId: 'workspace-1',
            type: EnumChatflowType.AGENTFLOW,
            isPublic: false,
            flowData: '{"secret":"private graph"}'
        })
        mockReadWorkspaceUserByUserId.mockResolvedValue([{ workspaceId: 'workspace-1' }])
        const response = createResponse()
        const next = jest.fn()

        await chatflowsController.getSinglePublicChatflow(
            createRequest({
                params: { id: 'agentflow-1' },
                user: { ...createRequest().user, id: 'user-1', permissions: ['chatflows:view'] }
            }),
            response as any,
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN }))
        expect(response.json).not.toHaveBeenCalledWith(expect.objectContaining({ flowData: expect.anything() }))
    })
})
