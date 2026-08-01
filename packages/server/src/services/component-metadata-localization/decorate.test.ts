import {
    decorateComponentCredentials,
    decorateCredentialMetadata,
    decorateDynamicOptions,
    decorateNodeMetadata,
    getDynamicMetadataPolicy,
    metadataTranslationKey
} from '.'

const stripDisplayFields = (value: any): any => {
    if (Array.isArray(value)) return value.map(stripDisplayFields)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => key !== 'displayLocale' && !/^display[A-Z]/.test(key))
            .map(([key, nestedValue]) => [key, stripDisplayFields(nestedValue)])
    )
}

describe('component metadata localization DTO', () => {
    const loopHint = 'Make sure to have memory enabled in the LLM/Agent node to retain the chat history'
    const agentNode = {
        name: 'agentAgentflow',
        label: 'Agent',
        type: 'Agent',
        category: 'Agent Flows',
        description: 'Dynamically choose and utilize tools during runtime, enabling multi-step reasoning',
        badge: 'NEW',
        version: 1,
        baseClasses: ['Agent'],
        inputs: [
            {
                name: 'agentKnowledgeDocumentStores',
                type: 'array',
                label: 'Knowledge (Document Stores)',
                description: 'Provide context to the agent from different document sources. Document Stores must be upserted beforehand.',
                array: [
                    {
                        name: 'docStoreDescription',
                        type: 'string',
                        label: 'Describe Knowledge',
                        placeholder:
                            'Describe what the knowledge base is about, this is useful for the AI to know when and how to search for correct information'
                    }
                ]
            }
        ]
    }

    it('adds Chinese display fields recursively and keeps every raw machine field unchanged', () => {
        const original = structuredClone(agentNode)
        const localized: any = decorateNodeMetadata(agentNode)

        expect(localized).not.toBe(agentNode)
        expect(localized.displayLocale).toBe('zh-CN')
        expect(localized.displayLabel).toBe('智能体')
        expect(localized.displayCategory).toBe('智能体流程')
        expect(localized.displayDescription).toBe('在运行时动态选择并使用工具，实现多步推理')
        expect(localized.displayBadge).toBe('新增')
        expect(localized.inputs[0].displayLabel).toBe('知识（文档库）')
        expect(localized.inputs[0].array[0].displayLabel).toBe('描述知识')
        expect(localized.inputs[0].array[0].displayPlaceholder).toContain('帮助 AI 判断')
        expect(stripDisplayFields(localized)).toEqual(original)
        expect(agentNode).toEqual(original)
    })

    it('fails closed when upstream source text changes', () => {
        const localized: any = decorateNodeMetadata({ ...agentNode, label: 'Agent changed upstream' })
        expect(localized.label).toBe('Agent changed upstream')
        expect(localized.displayLabel).toBeUndefined()
    })

    it('localizes a root string hint as additive display metadata', () => {
        const loop = { name: 'loopAgentflow', label: 'Loop', hint: loopHint, inputs: [] }
        const localized: any = decorateNodeMetadata(loop)

        expect(localized.hint).toBe(loopHint)
        expect(localized.displayHint).toBe('请确保已在大模型／智能体节点中启用记忆，以保留对话历史')
        expect(stripDisplayFields(localized)).toEqual(loop)
    })

    it('localizes plural output schemas while preserving names and numeric labels', () => {
        const humanInput = {
            name: 'humanInputAgentflow',
            label: 'Human Input',
            outputs: [
                { label: 'Proceed', name: 'proceed' },
                { label: 'Reject', name: 'reject' }
            ]
        }
        const condition = {
            name: 'conditionAgentflow',
            label: 'Condition',
            outputs: [
                { label: '0', name: '0', description: 'Condition 0' },
                { label: '1', name: '1', description: 'Else' }
            ]
        }

        const localizedHumanInput: any = decorateNodeMetadata(humanInput)
        const localizedCondition: any = decorateNodeMetadata(condition)

        expect(localizedHumanInput.outputs).toEqual([
            { label: 'Proceed', displayLabel: '继续', name: 'proceed' },
            { label: 'Reject', displayLabel: '拒绝', name: 'reject' }
        ])
        expect(localizedCondition.outputs).toEqual([
            { label: '0', displayLabel: '0', name: '0', description: 'Condition 0', displayDescription: '条件 0' },
            { label: '1', displayLabel: '1', name: '1', description: 'Else', displayDescription: '否则' }
        ])
        expect(stripDisplayFields(localizedHumanInput)).toEqual(humanInput)
        expect(stripDisplayFields(localizedCondition)).toEqual(condition)
    })

    it('does not reinterpret a non-array outputs object as metadata', () => {
        const runtimeOutputs = { displayLabel: 'legitimate runtime output', nested: { displayDescription: 'keep bytes' } }
        const localized: any = decorateNodeMetadata({ name: 'futureNode', label: 'Future Node', outputs: runtimeOutputs })

        expect(localized.outputs).toEqual(runtimeOutputs)
    })

    it('keeps unknown nodes raw while still providing a translated known category', () => {
        const raw = { name: 'futureNode', label: 'Future Node', type: 'Future', category: 'Tools', inputs: [] }
        const localized: any = decorateNodeMetadata(raw)
        expect(localized.displayLabel).toBeUndefined()
        expect(localized.displayCategory).toBe('工具')
        expect(stripDisplayFields(localized)).toEqual(raw)
    })

    it('uses stable source digests in catalog keys', () => {
        expect(metadataTranslationKey('node', 'agentAgentflow', 'root', 'label', 'Agent')).toBe(
            'node.agentAgentflow.root.label@11b39c93777e'
        )
    })

    it('declares dynamic policies without translating provider or tenant values', () => {
        expect(getDynamicMetadataPolicy('agentAgentflow', 'listModels')).toBe('metadata-ref')
        expect(getDynamicMetadataPolicy('agentAgentflow', 'listStores')).toBe('tenant-passthrough')
        expect(getDynamicMetadataPolicy('unknownNode', 'listModels')).toBeUndefined()

        const tenantOptions = [{ name: 'store-id', label: 'User-defined Store' }]
        expect(decorateDynamicOptions('agentAgentflow', 'listStores', tenantOptions)).toEqual(tenantOptions)
        expect(decorateDynamicOptions('agentAgentflow', 'listStores', tenantOptions)).not.toBe(tenantOptions)
    })

    it('clones credential metadata even when the first catalog batch has no matching key', () => {
        const credential = {
            name: 'futureCredential',
            label: 'Future Credential',
            inputs: [{ name: 'apiKey', type: 'password', label: 'API Key' }]
        }
        const localized = decorateCredentialMetadata(credential)
        expect(localized).not.toBe(credential)
        expect(localized.inputs).not.toBe(credential.inputs)
        expect(stripDisplayFields(localized)).toEqual(credential)
    })

    it('decorates a credential registry for NodeInfo without mutating the NodesPool source', () => {
        const credential = {
            name: 'deepseekApi',
            label: 'DeepseekAI API',
            inputs: [{ name: 'deepseekApiKey', type: 'password', label: 'DeepseekAI API Key' }]
        }
        const registry = { deepseekApi: credential }
        const localized: any = decorateComponentCredentials(registry)

        expect(localized).not.toBe(registry)
        expect(localized.deepseekApi).not.toBe(credential)
        expect(localized.deepseekApi.inputs[0]).toMatchObject({
            name: 'deepseekApiKey',
            label: 'DeepseekAI API Key',
            displayLabel: 'DeepSeek AI API 密钥'
        })
        expect(registry.deepseekApi.inputs[0]).not.toHaveProperty('displayLabel')
    })
})
