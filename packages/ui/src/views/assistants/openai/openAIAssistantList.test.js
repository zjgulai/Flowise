import { buildOpenAIAssistantCardIndex, filterOpenAIAssistantCards, getOpenAIAssistantCards } from './openAIAssistantList'

const storedAssistant = (overrides = {}) => ({
    id: 'stored-1',
    iconSrc: 'https://example.com/icon.svg',
    credential: 'credential-1',
    type: 'OPENAI',
    details: JSON.stringify({
        id: 'openai-1',
        name: '工单助手',
        description: '处理工单',
        model: 'gpt-4.1',
        instructions: '请按流程处理工单',
        temperature: 1,
        top_p: 1,
        tools: [],
        tool_resources: {}
    }),
    ...overrides
})

describe('OpenAI Assistant list projection', () => {
    it('projects validated records and keeps the original resource for editing', () => {
        const resource = storedAssistant()

        expect(getOpenAIAssistantCards([resource], '工单')).toEqual([
            {
                resource,
                name: '工单助手',
                description: '处理工单',
                iconSrc: 'https://example.com/icon.svg',
                searchText: '工单助手\n工单助手\nstored-1\nopenai-1'
            }
        ])
    })

    it('skips malformed records instead of crashing the whole list', () => {
        expect(
            getOpenAIAssistantCards(
                [storedAssistant(), storedAssistant({ id: 'broken-json', details: '{private invalid json' }), null, { id: 'partial' }],
                ''
            )
        ).toHaveLength(1)
    })

    it('fails closed for non-array responses and invalid search values', () => {
        expect(getOpenAIAssistantCards({ data: [] })).toEqual([])
        expect(getOpenAIAssistantCards([storedAssistant()], { unexpected: true })).toHaveLength(1)
    })

    it('keeps a schema-valid unnamed assistant visible and searchable by both IDs', () => {
        const unnamed = storedAssistant({
            id: 'stored-unnamed-1234567890',
            details: JSON.stringify({
                id: 'provider-unnamed-0987654321',
                name: '',
                description: '名称可选',
                model: 'gpt-future',
                instructions: '',
                temperature: null,
                top_p: null,
                tools: [],
                tool_resources: {}
            })
        })

        const cards = getOpenAIAssistantCards([unnamed])
        expect(cards).toHaveLength(1)
        expect(cards[0].name).toBe('未命名助手（provider-unnamed-0987654…）')
        expect(getOpenAIAssistantCards([unnamed], 'stored-unnamed-1234567890')).toHaveLength(1)
        expect(getOpenAIAssistantCards([unnamed], 'provider-unnamed-0987654321')).toHaveLength(1)
    })

    it('builds one validated index and filters repeated searches without reparsing', () => {
        const index = buildOpenAIAssistantCardIndex([storedAssistant(), storedAssistant({ id: 'broken', details: '{broken' })])

        expect(index.cards).toHaveLength(1)
        expect(index.invalidCount).toBe(1)
        expect(filterOpenAIAssistantCards(index.cards, '工单')).toHaveLength(1)
        expect(filterOpenAIAssistantCards(index.cards, 'stored-1')).toHaveLength(1)
        expect(filterOpenAIAssistantCards(index.cards, 'not-found')).toEqual([])
    })
})
