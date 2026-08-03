import * as fs from 'fs'
import { generateAgentflowv2, resolveSafeChatModelSelection } from 'flowise-components'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

jest.mock('fs', () => ({
    readdirSync: jest.fn(() => []),
    readFileSync: jest.fn()
}))

jest.mock('flowise-components', () => ({
    generateAgentflowv2: jest.fn(),
    resolveSafeChatModelSelection: jest.fn()
}))
jest.mock('../../utils', () => ({ databaseEntities: { Credential: 'credential-entity' } }))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() }
}))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
const mockAssertCredentialInWorkspace = jest.fn()
const mockRefreshOAuth2Credential = jest.fn()
const mockCreateWorkspaceOAuth2RefreshCapability = jest.fn((_workspaceId: string) => mockRefreshOAuth2Credential)
jest.mock('../credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: (...args: unknown[]) => mockAssertCredentialInWorkspace(...args) }
}))
jest.mock('../oauth2CredentialRefresh', () => ({
    createWorkspaceOAuth2RefreshCapability: (workspaceId: string) => mockCreateWorkspaceOAuth2RefreshCapability(workspaceId)
}))

import agentflowv2GeneratorService from '.'

const mockGenerateAgentflowv2 = generateAgentflowv2 as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const mockResolveSafeChatModelSelection = resolveSafeChatModelSelection as jest.Mock
const mockReadDir = fs.readdirSync as jest.Mock

const addJob = jest.fn()
const waitUntilFinished = jest.fn()
const getQueueEvents = jest.fn(() => ({ name: 'queue-events' }))
const getQueue = jest.fn(() => ({ addJob, getQueueEvents }))

const appServer = {
    AppDataSource: { name: 'test-data-source' },
    nodesPool: {
        componentNodes: {
            chatModel: {
                name: 'chatModel',
                category: 'Chat Models',
                baseClasses: ['BaseChatModel'],
                inputs: [],
                filePath: 'safe-chat-model'
            }
        }
    },
    queueManager: { getQueue }
}

describe('Agentflow V2 generator service workspace scoping', () => {
    const previousMode = process.env.MODE

    beforeEach(() => {
        jest.clearAllMocks()
        mockReadDir.mockReturnValue([])
        mockGetRunningExpressApp.mockReturnValue(appServer)
        mockGenerateAgentflowv2.mockResolvedValue({ nodes: [], edges: [] })
        mockResolveSafeChatModelSelection.mockImplementation((_nodes, selected) => ({
            component: appServer.nodesPool.componentNodes.chatModel,
            nodeData: { id: 'chatModel_0', name: 'chatModel', inputs: selected.inputs ?? {} },
            credentialId: selected.credential
        }))
        mockAssertCredentialInWorkspace.mockResolvedValue(undefined)
        waitUntilFinished.mockResolvedValue({ nodes: [], edges: [] })
        addJob.mockResolvedValue({ id: 'job-1', waitUntilFinished })
        delete process.env.MODE
    })

    afterAll(() => {
        if (previousMode === undefined) delete process.env.MODE
        else process.env.MODE = previousMode
    })

    it('passes the active workspace to direct component execution', async () => {
        await expect(
            agentflowv2GeneratorService.generateAgentflowv2('Create a support flow', { name: 'chatModel', inputs: {} }, 'workspace-1')
        ).resolves.toEqual({ nodes: [], edges: [] })

        expect(mockGenerateAgentflowv2).toHaveBeenCalledWith(
            expect.objectContaining({ selectedChatModel: { id: 'chatModel_0', name: 'chatModel', inputs: {} } }),
            'Create a support flow',
            expect.objectContaining({
                workspaceId: 'workspace-1',
                skipVariables: true,
                refreshOAuth2Credential: mockRefreshOAuth2Credential
            })
        )
        expect(mockCreateWorkspaceOAuth2RefreshCapability).toHaveBeenCalledWith('workspace-1')
    })

    it('serializes the active workspace into queue jobs', async () => {
        process.env.MODE = 'queue'

        await expect(
            agentflowv2GeneratorService.generateAgentflowv2('Create a support flow', { name: 'chatModel', inputs: {} }, 'workspace-queue')
        ).resolves.toEqual({ nodes: [], edges: [] })

        expect(addJob).toHaveBeenCalledWith(
            expect.objectContaining({
                question: 'Create a support flow',
                selectedChatModel: { id: 'chatModel_0', name: 'chatModel', inputs: {} },
                workspaceId: 'workspace-queue',
                isAgentFlowGenerator: true
            })
        )
        expect(addJob.mock.calls[0][0]).not.toHaveProperty('refreshOAuth2Credential')
        expect(mockCreateWorkspaceOAuth2RefreshCapability).not.toHaveBeenCalled()
        expect(mockGenerateAgentflowv2).not.toHaveBeenCalled()
    })

    it('fails closed before provider or queue execution without a workspace', async () => {
        await expect(
            agentflowv2GeneratorService.generateAgentflowv2('Create a support flow', { name: 'chatModel', inputs: {} }, '')
        ).rejects.toMatchObject({
            statusCode: 403
        })
        expect(mockGenerateAgentflowv2).not.toHaveBeenCalled()
        expect(addJob).not.toHaveBeenCalled()
    })

    it.each(['unknown', 'customFunction', 'vectorStore'])(
        'rejects unsafe %s component selections before queue or provider use',
        async () => {
            mockResolveSafeChatModelSelection.mockImplementationOnce(() => {
                throw new Error('sentinel raw component failure')
            })

            await expect(
                agentflowv2GeneratorService.generateAgentflowv2(
                    'Create a support flow',
                    { name: 'customFunction', inputs: {} },
                    'workspace-1'
                )
            ).rejects.toMatchObject({ statusCode: 400, message: 'Invalid chat model selection' })

            expect(addJob).not.toHaveBeenCalled()
            expect(mockGenerateAgentflowv2).not.toHaveBeenCalled()
        }
    )

    it('validates the selected credential in the active workspace before execution', async () => {
        mockResolveSafeChatModelSelection.mockReturnValueOnce({
            component: appServer.nodesPool.componentNodes.chatModel,
            nodeData: { id: 'chatModel_0', name: 'chatModel', inputs: {}, credential: 'credential-1' },
            credentialId: 'credential-1'
        })

        await agentflowv2GeneratorService.generateAgentflowv2(
            'Create a support flow',
            { name: 'chatModel', inputs: {}, credential: 'credential-1' },
            'workspace-1'
        )

        expect(mockAssertCredentialInWorkspace).toHaveBeenCalledWith('credential-1', 'workspace-1')
    })

    it('logs only a fixed aggregate when provider execution throws', async () => {
        const sentinel = 'sentinel-provider-secret-raw-error'
        mockGenerateAgentflowv2.mockRejectedValueOnce(new Error(sentinel))

        await expect(
            agentflowv2GeneratorService.generateAgentflowv2('Create a support flow', { name: 'chatModel', inputs: {} }, 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 500, message: 'Failed to generate Agentflowv2' })

        const logger = jest.requireMock('../../utils/logger').default
        expect(logger.error).toHaveBeenCalledWith('[server]: Failed to generate Agentflowv2', { failedCount: 1 })
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(sentinel)
    })
})
