const mockGetRunningExpressApp = jest.fn()

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => mockGetRunningExpressApp()
}))

import componentsCredentialsService from '.'

describe('components credentials localized display DTO contract', () => {
    const deepseekCredential = {
        name: 'deepseekApi',
        label: 'DeepseekAI API',
        inputs: [{ name: 'deepseekApiKey', type: 'password', label: 'DeepseekAI API Key' }]
    }
    const kimiCredential = {
        name: 'kimiApi',
        label: 'Kimi (Moonshot) API',
        inputs: [{ name: 'kimiApiKey', type: 'password', label: 'Kimi API Key' }]
    }

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({
            nodesPool: { componentCredentials: { deepseekApi: deepseekCredential, kimiApi: kimiCredential } }
        })
    })

    it('decorates the full component credential list without changing raw fields', async () => {
        const original = structuredClone(deepseekCredential)
        const response = await componentsCredentialsService.getAllComponentsCredentials()

        expect(response[0]).toMatchObject({
            name: 'deepseekApi',
            label: 'DeepseekAI API',
            displayLabel: 'DeepSeek AI API',
            displayLocale: 'zh-CN'
        })
        expect(response[0].inputs[0]).toMatchObject({
            name: 'deepseekApiKey',
            label: 'DeepseekAI API Key',
            displayLabel: 'DeepSeek AI API 密钥'
        })
        expect(response[0]).not.toBe(deepseekCredential)
        expect(deepseekCredential).toEqual(original)
    })

    it('clones and decorates single and multi-name responses without mutating the pool', async () => {
        const single: any = await componentsCredentialsService.getComponentByName('deepseekApi')
        const multiple: any[] = (await componentsCredentialsService.getComponentByName('deepseekApi&amp;kimiApi')) as any[]

        expect(single).not.toBe(deepseekCredential)
        expect(multiple).toHaveLength(2)
        expect(multiple[0]).not.toBe(deepseekCredential)
        expect(multiple[1]).not.toBe(kimiCredential)
        expect(single.name).toBe('deepseekApi')
        expect(single.displayLabel).toBe('DeepSeek AI API')
        expect(single.inputs[0].name).toBe('deepseekApiKey')
    })
})
