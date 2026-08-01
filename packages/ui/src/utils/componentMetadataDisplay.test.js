import {
    createMetadataDisplayView,
    getMetadataDisplayText,
    getMetadataOptionSearchText,
    getNodeMetadataSearchTexts,
    localizeOptionViews,
    parseFlowDataForCanvas,
    resolveCurrentMetadataItem,
    resolveInstanceDisplayLabel,
    sanitizeFlowDisplayMetadata,
    stripDisplayMetadata
} from './componentMetadataDisplay'

describe('component metadata display helpers', () => {
    const component = {
        name: 'agentAgentflow',
        label: 'Agent',
        displayLabel: '智能体',
        category: 'Agent Flows',
        displayCategory: '智能体流程',
        hint: 'Raw hint',
        displayHint: '中文提示',
        inputs: [
            {
                name: 'mode',
                type: 'options',
                label: 'Mode',
                displayLabel: '模式',
                options: [
                    { name: 'auto', label: 'Automatic', displayLabel: '自动' },
                    { name: 'manual', label: 'Manual', displayLabel: '手动' }
                ]
            }
        ]
    }

    it('prefers display text without replacing raw fields', () => {
        expect(getMetadataDisplayText(component, 'label')).toBe('智能体')
        expect(component.label).toBe('Agent')
        expect(component.category).toBe('Agent Flows')
        expect(getMetadataDisplayText(component, 'hint')).toBe('中文提示')
    })

    it('rejects non-string display metadata before it reaches React labels', () => {
        expect(getMetadataDisplayText({ label: 'Raw label', displayLabel: { malicious: true } }, 'label', 'Fallback')).toBe('Raw label')
        expect(getMetadataDisplayText({ label: ['not', 'text'], displayLabel: ['not', 'text'] }, 'label', 'Fallback')).toBe('Fallback')
    })

    it('resolves old flow input metadata against the current component registry', () => {
        const saved = {
            name: 'mode',
            type: 'options',
            label: 'Mode',
            displayLabel: '<img src=x onerror="globalThis.pwned=true">',
            displayDescription: '<script>globalThis.pwned=true</script>'
        }
        const current = resolveCurrentMetadataItem(component, saved)
        expect(current.displayLabel).toBe('模式')
        expect(current).toBe(component.inputs[0])
        expect(saved.displayLabel).toContain('onerror')
    })

    it('removes untrusted saved display fields when no current registry item exists', () => {
        const saved = {
            name: 'removedInput',
            type: 'string',
            label: 'Removed input',
            displayLabel: '<img src=x onerror="globalThis.pwned=true">',
            displayNameCreateChannel: 'Create｜customer channel\r\nkeep bytes'
        }

        expect(resolveCurrentMetadataItem(component, saved)).toEqual({
            name: 'removedInput',
            type: 'string',
            label: 'Removed input',
            displayNameCreateChannel: 'Create｜customer channel\r\nkeep bytes'
        })
    })

    it('creates localized option views while keeping submitted option names', () => {
        const rawOptions = component.inputs[0].options.map(({ displayLabel: _displayLabel, ...option }) => option)
        const localized = localizeOptionViews(rawOptions, component.inputs[0].options)
        expect(localized).toEqual([
            { name: 'auto', label: '自动', description: undefined },
            { name: 'manual', label: '手动', description: undefined }
        ])
        expect(localized.map((option) => option.name)).toEqual(['auto', 'manual'])
    })

    it('treats plural outputs as metadata only when they are a schema array', () => {
        const schema = {
            name: 'humanInputAgentflow',
            outputs: [
                { name: 'proceed', label: 'Proceed', displayLabel: '继续' },
                { name: 'reject', label: 'Reject', displayLabel: '拒绝' }
            ]
        }
        const runtime = {
            name: 'runtimeNode',
            outputs: { displayLabel: 'legitimate runtime output', nested: { displayDescription: 'keep bytes' } }
        }

        expect(createMetadataDisplayView(schema).outputs).toEqual([
            { name: 'proceed', label: '继续' },
            { name: 'reject', label: '拒绝' }
        ])
        expect(stripDisplayMetadata(schema).outputs).toEqual([
            { name: 'proceed', label: 'Proceed' },
            { name: 'reject', label: 'Reject' }
        ])
        expect(createMetadataDisplayView(runtime).outputs).toEqual(runtime.outputs)
        expect(stripDisplayMetadata(runtime).outputs).toEqual(runtime.outputs)
    })

    it('preserves string and mixed machine options without object coercion', () => {
        const rawOptions = ['plain-machine-option', { name: 'auto', label: 'Automatic' }]
        const localized = localizeOptionViews(rawOptions, [
            'plain-machine-option',
            { name: 'auto', label: 'Automatic', displayLabel: '自动', displayDescription: { malicious: true } }
        ])

        expect(localized).toEqual(['plain-machine-option', { name: 'auto', label: '自动', description: undefined }])
        expect(rawOptions).toEqual(['plain-machine-option', { name: 'auto', label: 'Automatic' }])
    })

    it('translates only system default instance labels', () => {
        expect(resolveInstanceDisplayLabel({ label: 'Agent' }, component)).toBe('智能体')
        expect(resolveInstanceDisplayLabel({ label: 'Agent 3' }, component)).toBe('智能体 3')
        expect(resolveInstanceDisplayLabel({ label: 'Agent (1)' }, component)).toBe('智能体 (1)')
        expect(resolveInstanceDisplayLabel({ label: 'Agent 3 (2)' }, component)).toBe('智能体 3 (2)')
        expect(resolveInstanceDisplayLabel({ label: 'My triage agent' }, component)).toBe('My triage agent')
    })

    it('supports both Chinese display search and raw technical search', () => {
        const texts = getNodeMetadataSearchTexts(component)
        expect(texts).toEqual(expect.arrayContaining(['agentAgentflow', 'Agent', '智能体', 'Agent Flows', '智能体流程']))
    })

    it('aggregates option name plus raw and Chinese label/description for bilingual search', () => {
        const searchText = getMetadataOptionSearchText({
            name: 'createChannel',
            label: 'Create Channel',
            displayLabel: '创建频道',
            description: 'Create a Microsoft Teams channel',
            displayDescription: '创建一个 Microsoft Teams 频道'
        })

        expect(searchText).toContain('createChannel')
        expect(searchText).toContain('Create Channel')
        expect(searchText).toContain('创建频道')
        expect(searchText).toContain('Create a Microsoft Teams channel')
        expect(searchText).toContain('创建一个 Microsoft Teams 频道')
        expect(getMetadataOptionSearchText('raw-option-name')).toBe('raw-option-name')
    })

    it('keeps raw static option text searchable without adding persistence fields', () => {
        const rawOptions = [{ name: 'createChannel', label: 'Create Channel', description: 'Create a Microsoft Teams channel' }]
        const localized = localizeOptionViews(rawOptions, [
            {
                ...rawOptions[0],
                displayLabel: '创建频道',
                displayDescription: '创建一个 Microsoft Teams 频道'
            }
        ])
        const localizedOption = localized[0]
        const searchText = getMetadataOptionSearchText(localizedOption)

        expect(searchText).toEqual(expect.stringContaining('Create Channel'))
        expect(searchText).toEqual(expect.stringContaining('创建频道'))
        expect(searchText).toEqual(expect.stringContaining('Create a Microsoft Teams channel'))
        expect(searchText).toEqual(expect.stringContaining('创建一个 Microsoft Teams 频道'))
        expect(localizedOption.name).toBe('createChannel')
        expect(Object.keys(localizedOption)).toEqual(['name', 'label', 'description'])
        expect(JSON.parse(JSON.stringify(localizedOption))).toEqual({
            name: 'createChannel',
            label: '创建频道',
            description: '创建一个 Microsoft Teams 频道'
        })
    })

    it('builds a render-only localized input view while preserving machine and runtime contracts', () => {
        const rawParam = {
            name: 'messages',
            type: 'array',
            label: 'Messages',
            placeholder: 'Enter a message',
            default: { displayLabel: 'legitimate default payload' },
            show: { mode: 'chat' },
            array: [{ name: 'content', type: 'string', label: 'Content', placeholder: 'Enter content' }]
        }
        const currentParam = {
            ...rawParam,
            displayLabel: '消息',
            displayPlaceholder: '输入消息',
            array: [
                {
                    ...rawParam.array[0],
                    displayLabel: '内容',
                    displayPlaceholder: '输入内容'
                }
            ]
        }

        const view = createMetadataDisplayView(rawParam, currentParam)

        expect(view).toMatchObject({ name: 'messages', type: 'array', label: '消息', placeholder: '输入消息' })
        expect(view.array[0]).toMatchObject({ name: 'content', type: 'string', label: '内容', placeholder: '输入内容' })
        expect(view.default).toEqual(rawParam.default)
        expect(view.show).toEqual(rawParam.show)
        expect(view.displayLabel).toBeUndefined()
        expect(rawParam.label).toBe('Messages')
    })

    it('recursively strips display metadata from persistence payloads', () => {
        const metadataWithBusinessDefaults = {
            ...component,
            displayNameCreateChannel: 'Create｜customer channel\r\nkeep bytes',
            displayNameUpdateChannel: 'Update｜customer channel\n保留',
            inputs: [
                {
                    ...component.inputs[0],
                    default: {
                        displayLabel: 'legitimate user default',
                        nested: { displayDescription: 'also legitimate inside a default value' }
                    }
                }
            ]
        }
        const sanitized = stripDisplayMetadata(metadataWithBusinessDefaults)
        expect(sanitized).toEqual({
            name: 'agentAgentflow',
            label: 'Agent',
            category: 'Agent Flows',
            hint: 'Raw hint',
            displayNameCreateChannel: 'Create｜customer channel\r\nkeep bytes',
            displayNameUpdateChannel: 'Update｜customer channel\n保留',
            inputs: [
                {
                    name: 'mode',
                    type: 'options',
                    label: 'Mode',
                    default: {
                        displayLabel: 'legitimate user default',
                        nested: { displayDescription: 'also legitimate inside a default value' }
                    },
                    options: [
                        { name: 'auto', label: 'Automatic' },
                        { name: 'manual', label: 'Manual' }
                    ]
                }
            ]
        })
        expect(component.displayLabel).toBe('智能体')
    })

    it('cleans only node metadata schema positions while preserving runtime payload keys byte-for-byte', () => {
        const createChannelName = 'Create｜customer channel 📣\r\nkeep bytes'
        const updateChannelName = 'Update｜customer channel 🛠️\n保留'
        const runtimePayload = {
            displayLabel: '<user-authored-displayLabel>',
            nested: { displayDescription: 'legitimate runtime field' }
        }
        const flowData = {
            nodes: [
                {
                    id: 'agentAgentflow_0',
                    type: 'agentFlow',
                    position: { x: 0, y: 0 },
                    data: {
                        name: 'agentAgentflow',
                        label: 'Agent',
                        displayLabel: '<img src=x onerror="globalThis.pwned=true">',
                        displayLocale: 'zh-CN',
                        inputParams: [
                            {
                                name: 'payload',
                                type: 'json',
                                label: 'Payload',
                                displayLabel: '载荷',
                                displayWarning: '<script>globalThis.pwned=true</script>',
                                default: { displayLabel: 'legitimate schema default value' }
                            }
                        ],
                        outputAnchors: [
                            {
                                id: 'agentAgentflow_0-output-0',
                                name: 'output',
                                label: 'Output',
                                displayLabel: '输出'
                            }
                        ],
                        inputs: {
                            displayNameCreateChannel: createChannelName,
                            displayNameUpdateChannel: updateChannelName,
                            payload: runtimePayload
                        },
                        outputs: { displayLabel: 'legitimate runtime output' }
                    }
                },
                {
                    id: 'conditionAgentflow_0',
                    data: {
                        name: 'conditionAgentflow',
                        label: 'Condition 0',
                        outputs: [{ name: '0', label: '0', displayLabel: '0', description: 'Condition 0', displayDescription: '条件 0' }]
                    }
                }
            ],
            edges: [{ id: 'edge-1', data: { displayLabel: 'legitimate edge payload' } }]
        }

        const sanitized = sanitizeFlowDisplayMetadata(flowData)

        expect(sanitized.nodes[0].data.displayLabel).toBeUndefined()
        expect(sanitized.nodes[0].data.displayLocale).toBeUndefined()
        expect(sanitized.nodes[0].data.inputParams[0].displayLabel).toBeUndefined()
        expect(sanitized.nodes[0].data.inputParams[0].displayWarning).toBeUndefined()
        expect(sanitized.nodes[0].data.outputAnchors[0].displayLabel).toBeUndefined()
        expect(sanitized.nodes[0].data.inputParams[0].default).toEqual({
            displayLabel: 'legitimate schema default value'
        })
        expect(sanitized.nodes[0].data.inputs.displayNameCreateChannel).toBe(createChannelName)
        expect(sanitized.nodes[0].data.inputs.displayNameUpdateChannel).toBe(updateChannelName)
        expect(sanitized.nodes[0].data.inputs.payload).toEqual(runtimePayload)
        expect(sanitized.nodes[0].data.outputs).toEqual({ displayLabel: 'legitimate runtime output' })
        expect(sanitized.nodes[1].data.outputs).toEqual([{ name: '0', label: '0', description: 'Condition 0' }])
        expect(sanitized.edges[0].data.displayLabel).toBe('legitimate edge payload')
        expect(flowData.nodes[0].data.displayLabel).toContain('onerror')
    })

    it('sanitizes legacy display metadata while parsing serialized canvas data', () => {
        const runtimePayload = { displayLabel: 'user value remains' }
        const serialized = JSON.stringify({
            nodes: [
                {
                    id: 'agentAgentflow_0',
                    data: {
                        displayLabel: 'legacy display label',
                        inputParams: [{ name: 'payload', displayLabel: '载荷' }],
                        inputs: { payload: runtimePayload }
                    }
                }
            ],
            edges: []
        })

        const parsed = parseFlowDataForCanvas(serialized)

        expect(parsed.nodes[0].data.displayLabel).toBeUndefined()
        expect(parsed.nodes[0].data.inputParams[0].displayLabel).toBeUndefined()
        expect(parsed.nodes[0].data.inputs.payload).toEqual(runtimePayload)
    })
})
