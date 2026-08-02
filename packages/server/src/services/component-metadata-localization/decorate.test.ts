import {
    decorateComponentCredentials,
    decorateCredentialMetadata,
    decorateDynamicOptions,
    decorateNodeMetadata,
    getDynamicMetadataPolicy,
    metadataSourceTranslationKey,
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

    it('adds render-only labels for primitive valueOptions without changing submitted values', () => {
        const condition = {
            name: 'seqCondition',
            label: 'Condition Agent',
            inputs: [
                {
                    name: 'condition',
                    datagrid: [
                        {
                            field: 'operation',
                            type: 'singleSelect',
                            valueOptions: ['Contains', 'Is Empty', 'Greater Than or Equal To']
                        }
                    ]
                }
            ]
        }

        const localized: any = decorateNodeMetadata(condition)
        const column = localized.inputs[0].datagrid[0]

        expect(column.valueOptions).toEqual(['Contains', 'Is Empty', 'Greater Than or Equal To'])
        expect(column.displayValueOptions).toEqual([
            { value: 'Contains', label: '包含' },
            { value: 'Is Empty', label: '为空' },
            { value: 'Greater Than or Equal To', label: '大于或等于' }
        ])
        expect(stripDisplayFields(localized)).toEqual(condition)
        expect(condition.inputs[0].datagrid[0].valueOptions).toEqual(['Contains', 'Is Empty', 'Greater Than or Equal To'])
    })

    it('keeps unknown nodes raw while still providing a translated known category', () => {
        const raw = { name: 'futureNode', label: 'Future Node', type: 'Future', category: 'Tools', inputs: [] }
        const localized: any = decorateNodeMetadata(raw)
        expect(localized.displayLabel).toBeUndefined()
        expect(localized.displayCategory).toBe('工具')
        expect(stripDisplayFields(localized)).toEqual(raw)
    })

    it.each(['constructor', 'toString', '__proto__'])('fails closed for unknown category and badge prototype key %s', (prototypeKey) => {
        const raw = {
            name: 'futureNode',
            label: 'Future Node',
            type: 'Future',
            category: prototypeKey,
            badge: prototypeKey,
            inputs: []
        }
        const localized: any = decorateNodeMetadata(raw)

        expect(localized.displayCategory).toBe(prototypeKey)
        expect(localized.displayBadge).toBe(prototypeKey)
        expect(stripDisplayFields(localized)).toEqual(raw)
    })

    it('prefers context-specific exact translations for ambiguous source labels', () => {
        const apiLoader: any = decorateNodeMetadata({
            name: 'apiLoader',
            inputs: [{ name: 'body', label: 'Body' }]
        })
        const gmail: any = decorateNodeMetadata({
            name: 'gmail',
            inputs: [{ name: 'messageBody', label: 'Body' }]
        })
        const calendar: any = decorateNodeMetadata({
            name: 'googleCalendarTool',
            inputs: [{ name: 'summary', label: 'Summary' }]
        })
        const jira: any = decorateNodeMetadata({
            name: 'jiraTool',
            inputs: [{ name: 'issueSummary', label: 'Summary' }]
        })

        expect(apiLoader.inputs[0].displayLabel).toBe('请求体')
        expect(gmail.inputs[0].displayLabel).toBe('正文')
        expect(calendar.inputs[0].displayLabel).toBe('标题')
        expect(jira.inputs[0].displayLabel).toBe('摘要')
    })

    it('uses stable source digests in catalog keys', () => {
        expect(metadataTranslationKey('node', 'agentAgentflow', 'root', 'label', 'Agent')).toBe(
            'node.agentAgentflow.root.label@11b39c93777e'
        )
        expect(metadataSourceTranslationKey('node', 'valueOption', 'Contains')).toBe('node.valueOption@2eaecb3d0cf1')
    })

    it('declares dynamic policies without translating provider or tenant values', () => {
        expect(getDynamicMetadataPolicy('agentAgentflow', 'listModels')).toBe('metadata-ref')
        expect(getDynamicMetadataPolicy('agentAgentflow', 'listStores')).toBe('tenant-passthrough')
        expect(getDynamicMetadataPolicy('awsSNS', 'listTopics')).toBe('provider-passthrough')
        expect(getDynamicMetadataPolicy('unknownNode', 'listModels')).toBeUndefined()

        const tenantOptions = [{ name: 'store-id', label: 'User-defined Store' }]
        const providerOptions = [{ name: 'topic-arn', label: 'User-defined Topic' }]
        expect(decorateDynamicOptions('agentAgentflow', 'listStores', tenantOptions)).toEqual(tenantOptions)
        expect(decorateDynamicOptions('agentAgentflow', 'listStores', tenantOptions)).not.toBe(tenantOptions)
        expect(decorateDynamicOptions('awsSNS', 'listTopics', providerOptions)).toEqual(providerOptions)
        expect(decorateDynamicOptions('awsSNS', 'listTopics', providerOptions)).not.toBe(providerOptions)
    })

    it('uses the full-node source catalog for metadata-reference dynamic options', () => {
        const options = [{ name: 'chatDeepseek', label: 'Deepseek', imageSrc: '/icons/deepseek.png' }]
        const localized: any = decorateDynamicOptions('agentAgentflow', 'listModels', options)

        expect(localized).toEqual([{ ...options[0], displayLabel: 'DeepSeek' }])
        expect(localized).not.toBe(options)
        expect(localized[0]).not.toBe(options[0])
        expect(options[0]).not.toHaveProperty('displayLabel')
    })

    it('localizes only static system-catalog descriptions and fails closed for unknown methods', () => {
        const systemOptions = [
            {
                name: 'claude-3-sonnet-20240229',
                label: 'Claude 3 Sonnet',
                description: 'Ideal balance of intelligence and speed for enterprise workloads'
            }
        ]
        const unknownOptions = [{ name: 'future-id', label: 'Future tenant value' }]
        const localized: any = decorateDynamicOptions('chatAnthropic', 'listModels', systemOptions)

        expect(localized).toEqual([
            {
                ...systemOptions[0],
                displayDescription: '企业工作负载下智能水平与速度的理想平衡'
            }
        ])
        expect(systemOptions[0]).not.toHaveProperty('displayDescription')
        expect(decorateDynamicOptions('futureNode', 'futureMethod', unknownOptions)).toEqual(unknownOptions)
        expect(decorateDynamicOptions('futureNode', 'futureMethod', unknownOptions)).not.toBe(unknownOptions)
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
