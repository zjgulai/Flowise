import { resolveSafeChatModelSelection } from 'flowise-components'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const mockInit = jest.fn()
const mockInvoke = jest.fn()

jest.mock(
    'safe-assistant-chat-model',
    () => ({
        nodeClass: class {
            init(...args: unknown[]) {
                return mockInit(...args)
            }
        }
    }),
    { virtual: true }
)

jest.mock('flowise-components', () => ({
    extractResponseContent: jest.fn((response) => response.content),
    resolveSafeChatModelSelection: jest.fn()
}))
jest.mock('../../utils', () => ({ databaseEntities: {} }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() }
}))
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

import assistantsService from '.'

const mockResolveSafeChatModelSelection = resolveSafeChatModelSelection as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const safeComponent = {
    name: 'safeModel',
    category: 'Chat Models',
    baseClasses: ['BaseChatModel'],
    inputs: [],
    filePath: 'safe-assistant-chat-model'
}

describe('assistant instruction generation component boundary', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            nodesPool: { componentNodes: { safeModel: safeComponent } }
        })
        mockResolveSafeChatModelSelection.mockReturnValue({
            component: safeComponent,
            nodeData: { id: 'safeModel_0', name: 'safeModel', inputs: {}, credential: 'credential-1' },
            credentialId: 'credential-1'
        })
        mockAssertCredentialInWorkspace.mockResolvedValue(undefined)
        mockInvoke.mockResolvedValue({ content: 'generated instruction' })
        mockInit.mockResolvedValue({ invoke: mockInvoke })
    })

    it.each(['unknown', 'customFunction', 'vectorStore'])(
        'rejects unsafe %s selections before import, initialization, variables, or provider use',
        async (name) => {
            mockResolveSafeChatModelSelection.mockImplementationOnce(() => {
                throw new Error('raw resolver sentinel')
            })

            await expect(
                assistantsService.generateAssistantInstruction('Write a support instruction', { name, inputs: {} }, 'workspace-1')
            ).rejects.toMatchObject({ statusCode: 400, message: 'Invalid assistant chat model selection' })

            expect(mockInit).not.toHaveBeenCalled()
            expect(mockInvoke).not.toHaveBeenCalled()
            expect(mockAssertCredentialInWorkspace).not.toHaveBeenCalled()
        }
    )

    it('checks credential ownership and disables variables for a legitimate model', async () => {
        await expect(
            assistantsService.generateAssistantInstruction(
                ' Write a support instruction ',
                { name: 'safeModel', inputs: {}, credential: 'credential-1' },
                'workspace-1'
            )
        ).resolves.toEqual({ content: 'generated instruction' })

        expect(mockAssertCredentialInWorkspace).toHaveBeenCalledWith('credential-1', 'workspace-1')
        expect(mockInit).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'safeModel', credential: 'credential-1' }),
            '',
            expect.objectContaining({
                workspaceId: 'workspace-1',
                skipVariables: true,
                refreshOAuth2Credential: mockRefreshOAuth2Credential
            })
        )
        expect(mockCreateWorkspaceOAuth2RefreshCapability).toHaveBeenCalledWith('workspace-1')
        expect(mockInvoke).toHaveBeenCalledTimes(1)
    })

    it.each(['', 'x'.repeat(4097)])('rejects invalid task bounds before model resolution', async (task) => {
        await expect(
            assistantsService.generateAssistantInstruction(task, { name: 'safeModel', inputs: {} }, 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 400 })
        expect(mockResolveSafeChatModelSelection).not.toHaveBeenCalled()
        expect(mockInit).not.toHaveBeenCalled()
    })

    it('rejects a cross-workspace credential before initialization', async () => {
        mockAssertCredentialInWorkspace.mockRejectedValueOnce(new Error('credential scope sentinel'))

        await expect(
            assistantsService.generateAssistantInstruction(
                'Write a support instruction',
                { name: 'safeModel', inputs: {}, credential: 'credential-1' },
                'workspace-other'
            )
        ).rejects.toMatchObject({ statusCode: 404, message: 'Assistant chat model credential not found' })
        expect(mockInit).not.toHaveBeenCalled()
        expect(mockInvoke).not.toHaveBeenCalled()
    })
})
