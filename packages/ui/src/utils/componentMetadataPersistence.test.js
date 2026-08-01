import { generateExportFlowData, initNode } from './genericHelper'

const forbiddenLocalizationFields = new Set([
    'displayLabel',
    'displayCategory',
    'displayDescription',
    'displayWarning',
    'displayPlaceholder',
    'displayBadge',
    'displayDeprecateMessage',
    'displayHeaderName',
    'displayHint',
    'displayLocale'
])

const expectMetadataSchemaToExcludeDisplayFields = (value) => {
    if (Array.isArray(value)) {
        value.forEach(expectMetadataSchemaToExcludeDisplayFields)
        return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, nestedValue] of Object.entries(value)) {
        expect(forbiddenLocalizationFields.has(key)).toBe(false)
        if (['inputParams', 'inputAnchors', 'outputAnchors', 'options', 'tabs', 'array', 'datagrid'].includes(key)) {
            expectMetadataSchemaToExcludeDisplayFields(nestedValue)
        }
    }
}

describe('component metadata persistence boundary', () => {
    const component = {
        name: 'agentAgentflow',
        label: 'Agent',
        displayLabel: '智能体',
        displayLocale: 'zh-CN',
        type: 'Agent',
        category: 'Agent Flows',
        displayCategory: '智能体流程',
        baseClasses: ['Agent'],
        inputs: [
            {
                name: 'mode',
                type: 'options',
                label: 'Mode',
                displayLabel: '模式',
                default: 'auto',
                options: [{ name: 'auto', label: 'Automatic', displayLabel: '自动' }]
            }
        ]
    }

    it('initializes raw flow data without mutating the API display DTO', () => {
        const original = structuredClone(component)
        const initialized = initNode(component, 'agentAgentflow_0', true)

        expect(JSON.stringify(initialized)).not.toMatch(/"display[A-Z]|"displayLocale"/)
        expect(initialized).toMatchObject({
            id: 'agentAgentflow_0',
            name: 'agentAgentflow',
            label: 'Agent',
            category: 'Agent Flows',
            inputs: { mode: 'auto' }
        })
        expect(initialized.inputParams[0]).toMatchObject({
            name: 'mode',
            type: 'options',
            label: 'Mode',
            default: 'auto'
        })
        expect(component).toEqual(original)
    })

    it('removes legacy display fields from export payloads while preserving machine values', () => {
        const initialized = initNode(component, 'agentAgentflow_0', true)
        initialized.displayLabel = '不应导出'
        initialized.inputParams[0].displayLabel = '不应导出'
        const createChannelName = 'Create｜customer channel 📣\r\nkeep bytes'
        const updateChannelName = 'Update｜customer channel 🛠️\n保留'
        const runtimePayload = {
            displayLabel: '<user-authored-displayLabel>',
            nested: { displayDescription: 'legitimate runtime field' }
        }
        initialized.inputs.displayNameCreateChannel = createChannelName
        initialized.inputs.displayNameUpdateChannel = updateChannelName
        initialized.inputs.payload = runtimePayload

        const exported = generateExportFlowData({
            nodes: [{ id: 'agentAgentflow_0', type: 'agentFlow', position: { x: 0, y: 0 }, data: initialized }],
            edges: []
        })

        expectMetadataSchemaToExcludeDisplayFields(exported.nodes[0].data)
        expect(exported.nodes[0].data.name).toBe('agentAgentflow')
        expect(exported.nodes[0].data.inputParams[0].name).toBe('mode')
        expect(exported.nodes[0].data.inputs.mode).toBe('auto')
        expect(exported.nodes[0].data.inputs.displayNameCreateChannel).toBe(createChannelName)
        expect(exported.nodes[0].data.inputs.displayNameUpdateChannel).toBe(updateChannelName)
        expect(exported.nodes[0].data.inputs.payload).toEqual(runtimePayload)
    })
})
