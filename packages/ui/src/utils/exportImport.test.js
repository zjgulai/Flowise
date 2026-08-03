import { exportData, getWorkspaceImportConfirmation } from './exportImport'

describe('workspace export browser handoff', () => {
    it('downloads the exact server-validated artifact and removes only the filename envelope', () => {
        const response = {
            FileDefaultName: 'ExportData.json',
            ChatFlow: [
                {
                    id: '11111111-1111-4111-8111-111111111111',
                    name: 'Synthetic flow',
                    flowData: '{"nodes":[],"edges":[]}',
                    chatbotConfig: '{"theme":"light"}',
                    analytic: '{"provider":"fixture"}',
                    speechToText: '{"enabled":true}',
                    textToSpeech: '{"enabled":true}',
                    followUpPrompts: '{"enabled":true}',
                    category: 'Training'
                }
            ],
            ExportManifest: { formatVersion: 1, dependencyMode: 'record-closure' }
        }

        expect(exportData(response)).toEqual({
            ChatFlow: response.ChatFlow,
            ExportManifest: response.ExportManifest
        })
        expect(response).toHaveProperty('FileDefaultName', 'ExportData.json')
    })
})

describe('workspace import manifest handoff', () => {
    const manifest = {
        formatVersion: 1,
        dependencyMode: 'record-closure',
        contentWarning: 'contains-user-data-and-custom-code-review-before-sharing',
        rebindRequired: [
            'credentials',
            'variable-values',
            'mcp-connections',
            'api-key-and-rate-limit-policy',
            'provider-and-http-options',
            'local-file-and-directory-paths'
        ],
        reviewRequired: ['preserved-provider-and-http-targets']
    }

    it('surfaces the content warning and every required rebind item before import', () => {
        const confirmation = getWorkspaceImportConfirmation({ ExportManifest: manifest })
        expect(confirmation.title).toBe('确认导入工作区数据')
        expect(confirmation.description).toContain('执行历史和错误文本')
        expect(confirmation.description).toContain('自定义代码及其他自由文本')
        expect(confirmation.description).toContain('凭据')
        expect(confirmation.description).toContain('变量值')
        expect(confirmation.description).toContain('MCP 连接')
        expect(confirmation.description).toContain('API 密钥与限流策略')
        expect(confirmation.description).toContain('模型服务商／HTTP 敏感选项')
        expect(confirmation.description).toContain('端点与主机地址')
    })

    it('uses a conservative warning for legacy files without a manifest', () => {
        expect(getWorkspaceImportConfirmation({ ChatFlow: [] }).description).toContain('无法确认其净化范围或依赖完整性')
    })

    it.each([
        { ...manifest, formatVersion: 2 },
        { ...manifest, contentWarning: 'missing' },
        { ...manifest, rebindRequired: ['credentials'] },
        { ...manifest, reviewRequired: [] }
    ])('rejects an unsupported or incomplete manifest %#', (ExportManifest) => {
        expect(() => getWorkspaceImportConfirmation({ ExportManifest })).toThrow()
    })
})
