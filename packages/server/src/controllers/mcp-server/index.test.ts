import { StatusCodes } from 'http-status-codes'

const mockMcpServerService = {
    getMcpServerConfig: jest.fn(),
    createMcpServerConfig: jest.fn(),
    updateMcpServerConfig: jest.fn(),
    deleteMcpServerConfig: jest.fn(),
    refreshMcpToken: jest.fn()
}

jest.mock('../../database/entities/ChatFlow', () => ({
    ChatFlow: class ChatFlow {},
    EnumChatflowType: { CHATFLOW: 'CHATFLOW', AGENTFLOW: 'AGENTFLOW', MULTIAGENT: 'MULTIAGENT', ASSISTANT: 'ASSISTANT' }
}))
jest.mock('../../services/mcp-server', () => ({ __esModule: true, default: mockMcpServerService }))

import { EnumChatflowType } from '../../database/entities/ChatFlow'
import mcpServerController from './index'

const createResponse = () => {
    const response = { status: jest.fn(), json: jest.fn(), set: jest.fn() }
    response.status.mockReturnValue(response)
    response.json.mockReturnValue(response)
    return response
}

const createRequest = (permissions: string[], isOrganizationAdmin = false) =>
    ({
        params: { id: 'flow-1' },
        body: {},
        user: { activeWorkspaceId: 'workspace-1', permissions, isOrganizationAdmin }
    } as any)

describe('mcpServerController config permission mapping', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockMcpServerService.getMcpServerConfig.mockResolvedValue({ enabled: false })
    })

    it('passes only Chatflow scope for a chatflows:config user', async () => {
        const response = createResponse()

        await mcpServerController.getMcpServerConfig(createRequest(['chatflows:config']), response as any, jest.fn())

        expect(mockMcpServerService.getMcpServerConfig).toHaveBeenCalledWith('flow-1', 'workspace-1', [EnumChatflowType.CHATFLOW])
        expect(response.json).toHaveBeenCalledWith({ enabled: false })
    })

    it('maps agentflows:config to both Agentflow generations', async () => {
        await mcpServerController.getMcpServerConfig(createRequest(['agentflows:config']), createResponse() as any, jest.fn())

        expect(mockMcpServerService.getMcpServerConfig).toHaveBeenCalledWith('flow-1', 'workspace-1', [
            EnumChatflowType.AGENTFLOW,
            EnumChatflowType.MULTIAGENT
        ])
    })

    it('allows organization admins only the three generic types', async () => {
        await mcpServerController.getMcpServerConfig(createRequest([], true), createResponse() as any, jest.fn())

        expect(mockMcpServerService.getMcpServerConfig).toHaveBeenCalledWith('flow-1', 'workspace-1', [
            EnumChatflowType.CHATFLOW,
            EnumChatflowType.AGENTFLOW,
            EnumChatflowType.MULTIAGENT
        ])
    })

    it('rejects missing config permission before the MCP service can select a secret', async () => {
        const next = jest.fn()

        await mcpServerController.getMcpServerConfig(createRequest(['chatflows:view']), createResponse() as any, next)

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN }))
        expect(mockMcpServerService.getMcpServerConfig).not.toHaveBeenCalled()
    })

    it.each([
        ['createMcpServerConfig', 'createMcpServerConfig'],
        ['updateMcpServerConfig', 'updateMcpServerConfig'],
        ['refreshMcpToken', 'refreshMcpToken']
    ])('marks every potentially token-issuing %s response as non-cacheable', async (controllerMethod, serviceMethod) => {
        mockMcpServerService[serviceMethod as keyof typeof mockMcpServerService].mockResolvedValue({ enabled: true, token: 'one-time' })
        const response = createResponse()

        await (mcpServerController[controllerMethod as keyof typeof mcpServerController] as any)(
            createRequest(['chatflows:config']),
            response as any,
            jest.fn()
        )

        expect(response.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
        expect(response.set).toHaveBeenCalledWith('Pragma', 'no-cache')
    })
})
