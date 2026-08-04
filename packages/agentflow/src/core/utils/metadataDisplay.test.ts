import type { NodeDataSchema } from '../types'

import {
    createMetadataDisplayView,
    getMetadataDisplayText,
    getMetadataOptionSearchText,
    resolveInstanceDisplayLabel,
    sanitizeFlowDisplayMetadata,
    stripDisplayMetadata
} from './metadataDisplay'

describe('getMetadataDisplayText', () => {
    it('returns the localized value without changing the raw metadata', () => {
        const source = { label: 'HTTP Request', displayLabel: 'HTTP 请求' }

        expect(getMetadataDisplayText(source, 'label')).toBe('HTTP 请求')
        expect(source.label).toBe('HTTP Request')
    })
})

describe('createMetadataDisplayView', () => {
    it('preserves machine fields while replacing only human-facing text', () => {
        const source = {
            name: 'llmAgentflow',
            type: 'options',
            default: 'deepseek-chat',
            label: 'Model',
            displayLabel: '模型'
        }

        const view = createMetadataDisplayView(source)

        expect(view).toEqual({
            name: 'llmAgentflow',
            type: 'options',
            default: 'deepseek-chat',
            label: '模型',
            displayLabel: '模型'
        })
    })

    it('does not mutate the API metadata used to create the display view', () => {
        const source = {
            name: 'llmAgentflow',
            label: 'LLM',
            displayLabel: '大模型',
            inputs: [{ name: 'prompt', type: 'string', label: 'Prompt', displayLabel: '提示词' }]
        }
        const original = structuredClone(source)

        createMetadataDisplayView(source)

        expect(source).toEqual(original)
    })

    it('keeps default/show/hide runtime contracts byte-for-byte while localizing metadata containers', () => {
        const defaultValue = {
            label: 'Runtime default label',
            displayLabel: 'must remain a runtime value',
            nested: { description: 'Runtime description', displayDescription: 'must also remain unchanged' }
        }
        const showContract = { operation: ['createChannel'], displayLabel: 'legitimate show key' }
        const hideContract = { operation: ['deleteChannel'], displayDescription: 'legitimate hide key' }
        const source = {
            name: 'payload',
            label: 'Payload',
            displayLabel: '载荷',
            default: defaultValue,
            show: showContract,
            hide: hideContract,
            options: [{ name: 'json', label: 'JSON Payload', displayLabel: 'JSON 载荷' }]
        }

        const view = createMetadataDisplayView(source)

        expect(view.label).toBe('载荷')
        expect(view.options[0].label).toBe('JSON 载荷')
        expect(view.default).toEqual(defaultValue)
        expect(view.show).toEqual(showContract)
        expect(view.hide).toEqual(hideContract)
        expect(source.default).toEqual(defaultValue)
    })

    it('preserves prototype-named own keys across display, strip, and flow persistence views', () => {
        const runtime = JSON.parse(
            '{"__proto__":{"polluted":"runtime"},"constructor":"runtime-constructor","prototype":"runtime-prototype","safe":1}'
        )
        const metadata = { name: 'payload', default: runtime }
        const flowData = { nodes: [{ id: 'node-0', data: { name: 'payloadNode', inputs: { payload: runtime } } }], edges: [] }

        const roundTrips = [
            createMetadataDisplayView(metadata).default,
            stripDisplayMetadata(metadata).default,
            sanitizeFlowDisplayMetadata(flowData).nodes[0]?.data.inputs.payload
        ]

        for (const roundTrip of roundTrips) {
            expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(runtime))
            expect(Object.prototype.hasOwnProperty.call(roundTrip, '__proto__')).toBe(true)
            expect(Object.prototype.hasOwnProperty.call(roundTrip, 'constructor')).toBe(true)
            expect(Object.prototype.hasOwnProperty.call(roundTrip, 'prototype')).toBe(true)
            expect(Object.getPrototypeOf(roundTrip)).toBe(Object.prototype)
            expect(roundTrip.polluted).toBeUndefined()
        }
    })

    it('fails safe for mixed option arrays and non-string display fields', () => {
        const source = {
            name: 'mode',
            label: 'Mode',
            displayLabel: { unexpected: true },
            options: ['legacy', { name: 'modern', label: 'Modern', displayLabel: '现代' }]
        }

        const view = createMetadataDisplayView(source)

        expect(view.label).toBe('Mode')
        expect(view.options).toEqual(['legacy', { name: 'modern', label: '现代', displayLabel: '现代' }])
        expect(getMetadataDisplayText(source, 'label')).toBe('Mode')
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
            { name: 'proceed', label: '继续', displayLabel: '继续' },
            { name: 'reject', label: '拒绝', displayLabel: '拒绝' }
        ])
        expect(stripDisplayMetadata(schema).outputs).toEqual([
            { name: 'proceed', label: 'Proceed' },
            { name: 'reject', label: 'Reject' }
        ])
        expect(createMetadataDisplayView(runtime).outputs).toEqual(runtime.outputs)
        expect(stripDisplayMetadata(runtime).outputs).toEqual(runtime.outputs)
    })

    it('renders localized valueOptions without changing their machine values', () => {
        const source = {
            field: 'operation',
            valueOptions: ['Contains', 'Is Empty'],
            displayValueOptions: [
                { value: 'Contains', label: '包含' },
                { value: 'Is Empty', label: '为空' }
            ]
        }

        const view = createMetadataDisplayView(source)

        expect(view.valueOptions).toEqual([
            { value: 'Contains', label: '包含' },
            { value: 'Is Empty', label: '为空' }
        ])
        expect(stripDisplayMetadata(source)).toEqual({ field: 'operation', valueOptions: ['Contains', 'Is Empty'] })
        expect(source.valueOptions).toEqual(['Contains', 'Is Empty'])
    })

    it('keeps primitive valueOptions as strings when no display sibling exists', () => {
        const source = { valueOptions: ['SAFE'] }

        expect(createMetadataDisplayView(source).valueOptions).toEqual(source.valueOptions)
    })

    it.each([
        ['mismatch and extra', [{ value: 'INJECTED', label: '伪造' }], ['SAFE', 'SECOND']],
        ['missing', [{ value: 'SAFE', label: '安全' }], ['安全', 'SECOND']],
        [
            'duplicate',
            [
                { value: 'SAFE', label: '安全' },
                { value: 'SAFE', label: '伪造' },
                { value: 'SECOND', label: '第二项' }
            ],
            ['SAFE', '第二项']
        ],
        [
            'reordered',
            [
                { value: 'SECOND', label: '第二项' },
                { value: 'SAFE', label: '安全' }
            ],
            ['安全', '第二项']
        ],
        [
            'malformed',
            [
                { value: 'SAFE', label: { malicious: true } },
                { value: 'SECOND', label: '' }
            ],
            ['SAFE', 'SECOND']
        ]
    ])('projects primitive value options from raw values for %s display metadata', (_case, displayValueOptions, labels) => {
        const source = { valueOptions: ['SAFE', 'SECOND'], displayValueOptions }
        const view = createMetadataDisplayView(source)

        expect(view.valueOptions.map((option) => (typeof option === 'string' ? option : option.value))).toEqual(source.valueOptions)
        expect(view.valueOptions.map((option) => (typeof option === 'string' ? option : option.label))).toEqual(labels)
    })

    it('localizes object valueOptions additively while preserving expression values', () => {
        const source = {
            field: 'variable',
            valueOptions: [{ value: '$flow.input', label: 'Input Question', displayLabel: '输入问题' }]
        }

        expect(createMetadataDisplayView(source).valueOptions).toEqual([
            { value: '$flow.input', label: '输入问题', displayLabel: '输入问题' }
        ])
        expect(stripDisplayMetadata(source)).toEqual({
            field: 'variable',
            valueOptions: [{ value: '$flow.input', label: 'Input Question' }]
        })
    })
})

describe('getMetadataOptionSearchText', () => {
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
    })

    it('retains raw English text outside JSON after creating a localized display view', () => {
        const view = createMetadataDisplayView({
            name: 'createChannel',
            label: 'Create Channel',
            displayLabel: '创建频道',
            description: 'Create a Microsoft Teams channel',
            displayDescription: '创建一个 Microsoft Teams 频道'
        })

        expect(view.label).toBe('创建频道')
        expect(view.description).toBe('创建一个 Microsoft Teams 频道')
        expect(getMetadataOptionSearchText(view)).toContain('Create Channel')
        expect(getMetadataOptionSearchText(view)).toContain('Create a Microsoft Teams channel')
        expect(Object.keys(view)).toEqual(['name', 'label', 'displayLabel', 'description', 'displayDescription'])
        expect(JSON.parse(JSON.stringify(view))).toEqual(view)
    })

    it('retains the original search text when a display view is recreated', () => {
        const firstView = createMetadataDisplayView({ label: 'Create Channel', displayLabel: '创建频道' })
        const secondView = createMetadataDisplayView(firstView)

        expect(getMetadataOptionSearchText(secondView)).toContain('Create Channel')
        expect(getMetadataOptionSearchText(secondView)).toContain('创建频道')
        expect(JSON.stringify(secondView)).not.toContain('Create Channel')
    })

    it('fails safe for strings, nullish values, and malicious non-string fields', () => {
        expect(getMetadataOptionSearchText('legacy')).toBe('legacy')
        expect(getMetadataOptionSearchText(null)).toBe('')
        expect(
            getMetadataOptionSearchText({ name: { malicious: true }, label: ['unexpected'], description: 42, displayLabel: '安全标签' })
        ).toBe('安全标签')
    })
})

describe('stripDisplayMetadata', () => {
    it('recursively removes additive display metadata while preserving raw values', () => {
        const source = {
            name: 'llmAgentflow',
            label: 'LLM',
            displayLabel: '大模型',
            displayLocale: 'zh-CN',
            inputs: [
                {
                    name: 'model',
                    type: 'options',
                    label: 'Model',
                    displayLabel: '模型',
                    options: [
                        {
                            name: 'deepseek-chat',
                            label: 'DeepSeek Chat',
                            displayLabel: 'DeepSeek 对话',
                            description: 'Chat model',
                            displayDescription: '对话模型'
                        }
                    ]
                }
            ]
        }

        expect(stripDisplayMetadata(source)).toEqual({
            name: 'llmAgentflow',
            label: 'LLM',
            inputs: [
                {
                    name: 'model',
                    type: 'options',
                    label: 'Model',
                    options: [{ name: 'deepseek-chat', label: 'DeepSeek Chat', description: 'Chat model' }]
                }
            ]
        })
    })

    it('does not mutate the metadata object being sanitized', () => {
        const source = {
            label: 'Tool',
            displayLabel: '工具',
            options: [{ name: 'lookup', label: 'Lookup', displayLabel: '查询' }]
        }
        const original = structuredClone(source)

        stripDisplayMetadata(source)

        expect(source).toEqual(original)
    })

    it('keeps the existing boolean display flag because it is not localization metadata', () => {
        const source = { name: 'advanced', display: false, displayLabel: '高级设置' }

        expect(stripDisplayMetadata(source)).toEqual({ name: 'advanced', display: false })
    })

    it('preserves business displayName fields and display-like keys inside schema default values byte-for-byte', () => {
        const createChannelName = 'Create｜customer channel 📣\r\nkeep bytes'
        const updateChannelName = 'Update｜customer channel 🛠️\n保留'
        const source = {
            name: 'microsoftTeams',
            label: 'Microsoft Teams',
            displayLabel: 'Microsoft Teams',
            displayNameCreateChannel: createChannelName,
            displayNameUpdateChannel: updateChannelName,
            inputs: [
                {
                    name: 'payload',
                    label: 'Payload',
                    displayLabel: '载荷',
                    type: 'json',
                    default: {
                        displayLabel: '<user-authored-displayLabel>',
                        nested: { displayDescription: 'legitimate default field' }
                    }
                }
            ]
        }

        const sanitized = stripDisplayMetadata(source)

        expect(sanitized.displayLabel).toBeUndefined()
        expect(sanitized.inputs[0].displayLabel).toBeUndefined()
        expect(sanitized.displayNameCreateChannel).toBe(createChannelName)
        expect(sanitized.displayNameUpdateChannel).toBe(updateChannelName)
        expect(sanitized.inputs[0].default).toEqual({
            displayLabel: '<user-authored-displayLabel>',
            nested: { displayDescription: 'legitimate default field' }
        })
    })
})

describe('sanitizeFlowDisplayMetadata', () => {
    it('removes only root and schema display metadata while preserving nested runtime payloads byte-for-byte', () => {
        const createChannelName = 'Create｜customer channel 📣\r\nkeep bytes'
        const updateChannelName = 'Update｜customer channel 🛠️\n保留'
        const runtimePayload = {
            displayLabel: '<user-authored-displayLabel>',
            nested: { displayDescription: 'legitimate runtime field' }
        }
        const flowData = {
            nodes: [
                {
                    id: 'microsoftTeams_0',
                    data: {
                        name: 'microsoftTeams',
                        label: 'Microsoft Teams',
                        displayLabel: '<img src=x onerror="globalThis.pwned=true">',
                        displayLocale: 'zh-CN',
                        inputParams: [
                            {
                                id: 'microsoftTeams_0-input-payload-json',
                                name: 'payload',
                                label: 'Payload',
                                displayLabel: '载荷',
                                type: 'json',
                                default: { displayLabel: 'legitimate schema default value' }
                            }
                        ],
                        outputAnchors: [
                            {
                                id: 'microsoftTeams_0-output-output-string',
                                name: 'output',
                                label: 'Output',
                                displayLabel: '输出',
                                type: 'string'
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
        const [sanitizedRuntimeNode, sanitizedSchemaNode] = sanitized.nodes
        const [sanitizedInputParam] = sanitizedRuntimeNode?.data.inputParams ?? []
        const [sanitizedOutputAnchor] = sanitizedRuntimeNode?.data.outputAnchors ?? []
        const sanitizedInputs = sanitizedRuntimeNode?.data.inputs
        const [sanitizedEdge] = sanitized.edges

        expect(sanitizedRuntimeNode).toBeDefined()
        expect(sanitizedSchemaNode).toBeDefined()
        expect(sanitizedInputParam).toBeDefined()
        expect(sanitizedOutputAnchor).toBeDefined()
        expect(sanitizedInputs).toBeDefined()
        expect(sanitizedEdge).toBeDefined()
        if (
            !sanitizedRuntimeNode ||
            !sanitizedSchemaNode ||
            !sanitizedInputParam ||
            !sanitizedOutputAnchor ||
            !sanitizedInputs ||
            !sanitizedEdge
        ) {
            throw new Error('Expected the metadata sanitizer fixture to preserve its node, anchor, input, and edge structure')
        }

        expect(sanitizedRuntimeNode.data.displayLabel).toBeUndefined()
        expect(sanitizedRuntimeNode.data.displayLocale).toBeUndefined()
        expect(sanitizedInputParam.displayLabel).toBeUndefined()
        expect(sanitizedOutputAnchor.displayLabel).toBeUndefined()
        expect(sanitizedInputParam.default).toEqual({
            displayLabel: 'legitimate schema default value'
        })
        expect(sanitizedInputs.displayNameCreateChannel).toBe(createChannelName)
        expect(sanitizedInputs.displayNameUpdateChannel).toBe(updateChannelName)
        expect(sanitizedInputs.payload).toEqual(runtimePayload)
        expect(sanitizedRuntimeNode.data.outputs).toEqual({ displayLabel: 'legitimate runtime output' })
        expect(sanitizedSchemaNode.data.outputs).toEqual([{ name: '0', label: '0', description: 'Condition 0' }])
        expect(sanitizedEdge.data.displayLabel).toBe('legitimate edge payload')
        expect(flowData.nodes[0].data.displayLabel).toContain('onerror')
    })
})

describe('resolveInstanceDisplayLabel', () => {
    const component = {
        name: 'llmAgentflow',
        label: 'LLM',
        displayLabel: '大模型'
    } as NodeDataSchema

    it('localizes an exact system-generated instance label', () => {
        expect(resolveInstanceDisplayLabel({ label: 'LLM' }, component)).toBe('大模型')
    })

    it('localizes a numbered system-generated instance label without changing its suffix', () => {
        expect(resolveInstanceDisplayLabel({ label: 'LLM 12' }, component)).toBe('大模型 12')
    })

    it('localizes system-generated duplicate suffixes while preserving their machine-generated shape', () => {
        expect(resolveInstanceDisplayLabel({ label: 'LLM (1)' }, component)).toBe('大模型 (1)')
        expect(resolveInstanceDisplayLabel({ label: 'LLM 0 (2)' }, component)).toBe('大模型 0 (2)')
    })

    it('preserves a user-authored instance label byte-for-byte', () => {
        expect(resolveInstanceDisplayLabel({ label: '一线客服主模型' }, component)).toBe('一线客服主模型')
        expect(resolveInstanceDisplayLabel({ label: '我的节点 (1)' }, component)).toBe('我的节点 (1)')
        expect(resolveInstanceDisplayLabel({ label: 'LLM 自定义 (1)' }, component)).toBe('LLM 自定义 (1)')
    })
})
