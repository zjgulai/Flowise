import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const mockAssertCredentialInWorkspace = jest.fn()

jest.mock('../credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: (...args: unknown[]) => mockAssertCredentialInWorkspace(...args) }
}))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn() } }))

import evaluationsService from '.'

const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock

describe('LLM evaluation credential authorization', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({
            nodesPool: {
                componentNodes: {
                    evaluationModel: {
                        name: 'evaluationModel',
                        category: 'Chat Models',
                        baseClasses: ['BaseChatModel'],
                        credential: { name: 'credential', type: 'credential', credentialNames: ['providerCredential'] },
                        filePath: 'unused-model-module',
                        inputs: [{ name: 'modelName', type: 'asyncOptions' }]
                    }
                }
            }
        })
    })

    const body = {
        name: 'Evaluation',
        evaluationType: 'llm',
        credentialId: 'credential-1',
        datasetId: 'dataset-1',
        datasetName: 'Dataset',
        chatflowId: JSON.stringify(['chatflow-1']),
        chatflowName: JSON.stringify(['Chatflow']),
        chatflowType: JSON.stringify(['Chatflow']),
        selectedSimpleEvaluators: '',
        selectedLLMEvaluators: JSON.stringify(['evaluator-1']),
        llm: 'evaluationModel',
        model: 'model-1'
    }

    it('rejects a cross-workspace credential before creating evaluation state', async () => {
        mockAssertCredentialInWorkspace.mockRejectedValue(new InternalFlowiseError(404, 'Credential not found'))

        await expect(
            evaluationsService.createEvaluation(body, 'https://flowise.example.test', 'organization-1', 'workspace-other')
        ).rejects.toMatchObject({ statusCode: 404 })

        expect(mockAssertCredentialInWorkspace).toHaveBeenCalledWith('credential-1', 'workspace-other')
        expect(mockGetRunningExpressApp).toHaveBeenCalledTimes(1)
    })

    it('fails closed before credential or database access without a workspace', async () => {
        await expect(evaluationsService.createEvaluation(body, 'https://flowise.example.test', 'organization-1', '')).rejects.toMatchObject(
            { statusCode: 403 }
        )

        expect(mockAssertCredentialInWorkspace).not.toHaveBeenCalled()
        expect(mockGetRunningExpressApp).not.toHaveBeenCalled()
    })
})
