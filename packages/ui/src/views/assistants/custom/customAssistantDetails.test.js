import {
    CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION,
    deriveCustomAssistantToolNodeId,
    deriveDocumentStoreRetrieverToolName,
    isExpectedCustomAssistantResource,
    isCustomAssistantBackingFlowReady,
    parseCustomAssistantDetails,
    validateCustomAssistantSaveResponse
} from './customAssistantDetails'

it('derives tool references from the current name and index instead of stale persisted ids', () => {
    expect(deriveCustomAssistantToolNodeId('ticketTool', 0)).toBe('ticketTool_0')
    expect(deriveCustomAssistantToolNodeId('ticketTool', 1)).toBe('ticketTool_1')
})

describe('document store retriever tool names', () => {
    it('keeps a safe ASCII label and bounds its length', () => {
        expect(deriveDocumentStoreRetrieverToolName('Ticket Knowledge Base', 'store-1', 0)).toBe('ticket_knowledge_base')
        expect(deriveDocumentStoreRetrieverToolName('A'.repeat(100), 'store-1', 0)).toHaveLength(64)
    })

    it('uses a stable non-empty fallback for Chinese, punctuation-only and colliding labels', () => {
        expect(deriveDocumentStoreRetrieverToolName('知识库', 'Store-ABC', 0)).toBe('document_store_store-abc')
        expect(deriveDocumentStoreRetrieverToolName('___', '', 2)).toBe('document_store_3')
        expect(deriveDocumentStoreRetrieverToolName('研发 文档', 'store-2', 1)).toBe('document_store_store-2')
    })
})

describe('custom assistant resource identity', () => {
    it('accepts only the exact expected CUSTOM assistant', () => {
        const assistant = { id: 'assistant-1', type: 'CUSTOM', details: '{}' }
        expect(isExpectedCustomAssistantResource('assistant-1', assistant)).toBe(true)
        expect(isExpectedCustomAssistantResource('assistant-2', assistant)).toBe(false)
        expect(isExpectedCustomAssistantResource('assistant-1', { ...assistant, type: 'OPENAI' })).toBe(false)
        expect(isExpectedCustomAssistantResource('assistant-1', { ...assistant, details: null })).toBe(false)
        expect(isExpectedCustomAssistantResource('', assistant)).toBe(false)
    })
})

describe('custom assistant backing flow identity', () => {
    it('accepts only the exact expected ASSISTANT flow', () => {
        expect(isCustomAssistantBackingFlowReady('flow-1', { id: 'flow-1', type: 'ASSISTANT' })).toBe(true)
        expect(isCustomAssistantBackingFlowReady('flow-1', { id: 'flow-2', type: 'ASSISTANT' })).toBe(false)
        expect(isCustomAssistantBackingFlowReady('flow-1', { id: 'flow-1', type: 'CHATFLOW' })).toBe(false)
        expect(isCustomAssistantBackingFlowReady('flow-1', { id: 'flow-1', type: 'AGENTFLOW' })).toBe(false)
        expect(isCustomAssistantBackingFlowReady('', { id: 'flow-1', type: 'ASSISTANT' })).toBe(false)
        expect(isCustomAssistantBackingFlowReady('flow-1', null)).toBe(false)
    })
})

describe('parseCustomAssistantDetails', () => {
    it('normalizes the minimal payload created for a new custom assistant', () => {
        expect(parseCustomAssistantDetails('{"name":"  新助手  "}')).toEqual({
            name: '新助手',
            chatModel: {},
            instruction: CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION,
            flowId: undefined,
            documentStores: [],
            tools: []
        })
    })

    it('normalizes safe component and document-store defaults', () => {
        const details = parseCustomAssistantDetails(
            JSON.stringify({
                name: 'Assistant',
                chatModel: { name: 'deepseekChat' },
                instruction: '',
                flowId: ' flow-1 ',
                documentStores: [{ id: ' store-1 ' }],
                tools: [{ name: 'ticketTool' }]
            })
        )

        expect(details).toMatchObject({
            chatModel: { name: 'deepseekChat', inputs: {}, inputParams: [] },
            instruction: '',
            flowId: 'flow-1',
            documentStores: [{ id: 'store-1', name: '', description: '', returnSourceDocuments: false }],
            tools: [{ name: 'ticketTool', inputs: {}, inputParams: [] }]
        })
    })

    it.each([
        ['null', 'null'],
        ['array', '[]'],
        ['missing name', '{}'],
        ['non-string instruction', '{"name":"A","instruction":{}}'],
        ['invalid flowId', '{"name":"A","flowId":"  "}'],
        ['non-array documentStores', '{"name":"A","documentStores":{}}'],
        ['malformed document store', '{"name":"A","documentStores":[null]}'],
        ['non-array tools', '{"name":"A","tools":{}}'],
        ['tool without a name', '{"name":"A","tools":[{}]}'],
        ['chat model with array inputs', '{"name":"A","chatModel":{"name":"model","inputs":[]}}'],
        ['chat model with object inputParams', '{"name":"A","chatModel":{"name":"model","inputParams":{}}}'],
        ['chat model with a null inputParam', '{"name":"A","chatModel":{"name":"model","inputParams":[null]}}'],
        [
            'chat model with a malformed option',
            '{"name":"A","chatModel":{"name":"model","inputParams":[{"name":"mode","options":[null]}]}}'
        ],
        ['tool with a nameless inputParam', '{"name":"A","tools":[{"name":"tool","inputParams":[{}]}]}']
    ])('rejects %s without exposing the source payload', (_label, serializedDetails) => {
        expect(() => parseCustomAssistantDetails(serializedDetails)).toThrow()
    })
})

describe('validateCustomAssistantSaveResponse', () => {
    const expectedFlowData = JSON.stringify({ nodes: [], edges: [] })
    const validResponse = {
        assistant: {
            id: 'assistant-1',
            type: 'CUSTOM',
            details: JSON.stringify({ name: 'Existing assistant', flowId: 'flow-1' }),
            updatedDate: '2026-08-02T08:01:00.000Z'
        },
        chatflow: {
            id: 'flow-1',
            name: 'Existing assistant',
            type: 'ASSISTANT',
            flowData: expectedFlowData,
            updatedDate: '2026-08-02T08:01:00.000Z'
        }
    }

    it('returns only a complete response that matches the requested assistant and flow payload', () => {
        expect(
            validateCustomAssistantSaveResponse(validResponse, {
                assistantId: 'assistant-1',
                expectedFlowData
            })
        ).toMatchObject({
            assistant: { id: 'assistant-1', type: 'CUSTOM' },
            chatflow: { id: 'flow-1', type: 'ASSISTANT', flowData: expectedFlowData },
            details: { name: 'Existing assistant', flowId: 'flow-1' }
        })
    })

    it.each([
        ['missing assistant id', { ...validResponse, assistant: { ...validResponse.assistant, id: undefined } }],
        ['wrong assistant type', { ...validResponse, assistant: { ...validResponse.assistant, type: 'OPENAI' } }],
        ['wrong flow type', { ...validResponse, chatflow: { ...validResponse.chatflow, type: 'CHATFLOW' } }],
        ['different flow payload', { ...validResponse, chatflow: { ...validResponse.chatflow, flowData: '{"nodes":[]}' } }],
        [
            'inconsistent flow reference',
            {
                ...validResponse,
                assistant: {
                    ...validResponse.assistant,
                    details: JSON.stringify({ name: 'Existing assistant', flowId: 'flow-2' })
                }
            }
        ]
    ])('rejects %s', (_label, responseData) => {
        expect(() =>
            validateCustomAssistantSaveResponse(responseData, {
                assistantId: 'assistant-1',
                expectedFlowData
            })
        ).toThrow()
    })
})
