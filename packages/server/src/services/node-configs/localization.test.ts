const mockGetRunningExpressApp = jest.fn()

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => mockGetRunningExpressApp()
}))

import nodeConfigsService from '.'

describe('NodeInfo credential config localization contract', () => {
    const credential = {
        name: 'deepseekApi',
        label: 'DeepseekAI API',
        inputs: [{ name: 'deepseekApiKey', type: 'password', label: 'DeepseekAI API Key' }]
    }

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({
            nodesPool: { componentCredentials: { deepseekApi: credential } }
        })
    })

    it('returns a Chinese human label while preserving the credential machine name and pool source', async () => {
        const original = structuredClone(credential)
        const response = await nodeConfigsService.getAllNodeConfigs({
            id: 'agentAgentflow_0',
            label: 'Agent 0',
            inputParams: [{ name: 'credential', type: 'credential', label: 'Connect Credential', credentialNames: ['deepseekApi'] }]
        })

        expect(response).toEqual([
            {
                node: 'Agent 0',
                nodeId: 'agentAgentflow_0',
                label: 'DeepseekAI API Key',
                displayLabel: 'DeepSeek AI API 密钥',
                name: 'deepseekApiKey',
                type: 'string'
            }
        ])
        expect(credential).toEqual(original)
    })
})
