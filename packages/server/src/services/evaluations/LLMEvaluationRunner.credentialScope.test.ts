import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

let mockCredentialShareActive = true
const mockRefreshOAuth2Credential = jest.fn()
const mockCreateWorkspaceOAuth2RefreshCapability = jest.fn((_workspaceId: string) => mockRefreshOAuth2Credential)
const mockAssertCredentialInWorkspace = jest.fn(async (_credentialId: string, _workspaceId: string) => {
    if (!mockCredentialShareActive) throw new Error('Credential is not available in this workspace')
})
const mockMaliciousModuleImport = jest.fn()
const mockInit = jest.fn(async (_nodeData: unknown, _input: unknown, options: Record<string, unknown>) => {
    if (options.workspaceId !== 'workspace-1') throw new Error('Workspace is required')
    return { withStructuredOutput: jest.fn() }
})

jest.mock(
    'workspace-scoped-evaluation-model',
    () => ({
        nodeClass: class {
            init(...args: [unknown, unknown, Record<string, unknown>]) {
                return mockInit(...args)
            }
        }
    }),
    { virtual: true }
)

jest.mock(
    'malicious-evaluation-model',
    () => {
        mockMaliciousModuleImport()
        return {
            nodeClass: class {
                init(...args: [unknown, unknown, Record<string, unknown>]) {
                    return mockInit(...args)
                }
            }
        }
    },
    { virtual: true }
)

jest.mock('../../utils', () => ({ databaseEntities: { Credential: 'credential-entity' } }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: (...args: [string, string]) => mockAssertCredentialInWorkspace(...args) }
}))
jest.mock('../oauth2CredentialRefresh', () => ({
    createWorkspaceOAuth2RefreshCapability: (workspaceId: string) => mockCreateWorkspaceOAuth2RefreshCapability(workspaceId)
}))

import { LLMEvaluationRunner } from './LLMEvaluationRunner'

const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const safeComponent = {
    name: 'evaluationModel',
    category: 'Chat Models',
    baseClasses: ['BaseChatModel'],
    credential: { name: 'credential', type: 'credential', credentialNames: ['providerCredential'] },
    filePath: 'workspace-scoped-evaluation-model',
    inputs: [{ name: 'modelName', type: 'asyncOptions' }]
}
const llmData = {
    llmConfig: {
        llm: 'evaluationModel',
        model: 'model-1',
        credentialId: 'credential-1'
    }
}

describe('LLMEvaluationRunner runtime component and credential boundary', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCredentialShareActive = true
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            nodesPool: { componentNodes: { evaluationModel: { ...safeComponent } } }
        })
    })

    it('constructs fixed node data and injects the workspace refresh capability', async () => {
        await expect(
            new LLMEvaluationRunner('workspace-1').createLLM({
                ...llmData,
                filePath: 'malicious-evaluation-model',
                inputs: { arbitrary: 'attacker-controlled' }
            })
        ).resolves.toBeDefined()

        expect(mockInit).toHaveBeenCalledWith(
            {
                id: 'evaluationModel_0',
                name: 'evaluationModel',
                inputs: { modelName: 'model-1' },
                credential: 'credential-1'
            },
            undefined,
            expect.objectContaining({
                workspaceId: 'workspace-1',
                refreshOAuth2Credential: mockRefreshOAuth2Credential
            })
        )
        expect(mockCreateWorkspaceOAuth2RefreshCapability).toHaveBeenCalledWith('workspace-1')
        expect(mockAssertCredentialInWorkspace).toHaveBeenCalledWith('credential-1', 'workspace-1')
        expect(mockMaliciousModuleImport).not.toHaveBeenCalled()
    })

    it('blocks model creation immediately after credential share revocation', async () => {
        await expect(new LLMEvaluationRunner('workspace-1').createLLM(llmData)).resolves.toBeDefined()
        mockCredentialShareActive = false

        await expect(new LLMEvaluationRunner('workspace-1').createLLM(llmData)).rejects.toThrow('Error creating LLM')
        expect(mockAssertCredentialInWorkspace).toHaveBeenCalledTimes(2)
        expect(mockInit).toHaveBeenCalledTimes(1)
        expect(mockCreateWorkspaceOAuth2RefreshCapability).toHaveBeenCalledTimes(1)
    })

    it('fails closed without a workspace before registry access or model initialization', async () => {
        await expect(new LLMEvaluationRunner('').createLLM(llmData)).rejects.toThrow('Error creating LLM')
        expect(mockGetRunningExpressApp).not.toHaveBeenCalled()
        expect(mockAssertCredentialInWorkspace).not.toHaveBeenCalled()
        expect(mockInit).not.toHaveBeenCalled()
        expect(mockCreateWorkspaceOAuth2RefreshCapability).not.toHaveBeenCalled()
    })

    it.each([
        ['mismatched identity', { name: 'differentModel' }],
        ['non-chat category', { category: 'Tools', filePath: 'malicious-evaluation-model' }],
        ['missing BaseChatModel', { baseClasses: ['Runnable'], filePath: 'malicious-evaluation-model' }],
        ['undeclared credential', { credential: undefined, filePath: 'malicious-evaluation-model' }],
        ['missing file path', { filePath: '' }],
        ['overlong file path', { filePath: 'x'.repeat(4097) }],
        ['undeclared model input', { inputs: [{ name: 'endpoint', type: 'string' }] }]
    ])('rejects a %s component before import, capability creation, or initialization', async (_label, override) => {
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            nodesPool: { componentNodes: { evaluationModel: { ...safeComponent, ...override } } }
        })

        await expect(new LLMEvaluationRunner('workspace-1').createLLM(llmData)).rejects.toThrow('Error creating LLM')

        expect(mockMaliciousModuleImport).not.toHaveBeenCalled()
        expect(mockAssertCredentialInWorkspace).not.toHaveBeenCalled()
        expect(mockCreateWorkspaceOAuth2RefreshCapability).not.toHaveBeenCalled()
        expect(mockInit).not.toHaveBeenCalled()
    })

    it('maps the model only to a declared string model input', async () => {
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            nodesPool: {
                componentNodes: {
                    evaluationModel: { ...safeComponent, inputs: [{ name: 'model', type: 'string' }] }
                }
            }
        })

        await new LLMEvaluationRunner('workspace-1').createLLM(llmData)

        expect(mockInit.mock.calls[0][0]).toEqual(expect.objectContaining({ name: 'evaluationModel', inputs: { model: 'model-1' } }))
    })

    it('rejects a model outside a declared static option before import or initialization', async () => {
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            nodesPool: {
                componentNodes: {
                    evaluationModel: {
                        ...safeComponent,
                        inputs: [{ name: 'modelName', type: 'options', options: [{ name: 'allowed-model' }] }]
                    }
                }
            }
        })

        await expect(new LLMEvaluationRunner('workspace-1').createLLM(llmData)).rejects.toThrow('Error creating LLM')
        expect(mockInit).not.toHaveBeenCalled()
        expect(mockCreateWorkspaceOAuth2RefreshCapability).not.toHaveBeenCalled()
    })

    it.each([
        ['llm', 'x'.repeat(129), 'model-1'],
        ['model', 'evaluationModel', 'x'.repeat(513)]
    ])('rejects an overlong %s before import or initialization', async (_field, llm, model) => {
        await expect(
            new LLMEvaluationRunner('workspace-1').createLLM({ llmConfig: { llm, model, credentialId: 'credential-1' } })
        ).rejects.toThrow('Error creating LLM')
        expect(mockInit).not.toHaveBeenCalled()
        expect(mockCreateWorkspaceOAuth2RefreshCapability).not.toHaveBeenCalled()
    })

    it('accepts the exact llm and model length limits', async () => {
        const llm = 'x'.repeat(128)
        const model = 'm'.repeat(512)
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            nodesPool: { componentNodes: { [llm]: { ...safeComponent, name: llm } } }
        })

        await expect(
            new LLMEvaluationRunner('workspace-1').createLLM({ llmConfig: { llm, model, credentialId: 'credential-1' } })
        ).resolves.toBeDefined()

        expect(mockInit.mock.calls[0][0]).toEqual(expect.objectContaining({ id: `${llm}_0`, inputs: { modelName: model } }))
    })
})
