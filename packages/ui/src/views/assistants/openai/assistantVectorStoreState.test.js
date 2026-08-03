import {
    buildAssistantVectorStoreMutationBody,
    isAssistantVectorStoreOperationCurrent,
    parseAssistantVectorStore,
    parseAssistantVectorStoreExpirationDays,
    parseAssistantVectorStoreList,
    validateAssistantVectorStoreMutation,
    validateAssistantVectorStoreDeletion
} from './assistantVectorStoreState'

const vectorStore = (overrides = {}) => ({
    id: 'vs-1',
    object: 'vector_store',
    name: '知识库',
    status: 'completed',
    expires_after: { anchor: 'last_active_at', days: 7 },
    file_counts: { in_progress: 0, completed: 1, failed: 0, cancelled: 0, total: 1 },
    usage_bytes: 42,
    ...overrides
})

describe('OpenAI assistant vector-store response contracts', () => {
    it('accepts a correlated vector store and a unique list', () => {
        expect(parseAssistantVectorStore(vectorStore(), 'vs-1').success).toBe(true)
        expect(parseAssistantVectorStoreList([vectorStore(), vectorStore({ id: 'vs-2' })]).success).toBe(true)
    })

    it.each([
        ['missing id', vectorStore({ id: '' }), undefined],
        ['wrong id', vectorStore(), 'vs-other'],
        ['invalid expiration', vectorStore({ expires_after: { anchor: 'last_active_at', days: 0 } }), undefined],
        [
            'invalid file count',
            vectorStore({ file_counts: { in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 1 } }),
            undefined
        ],
        ['missing object discriminator', vectorStore({ object: undefined }), undefined],
        ['invalid status', vectorStore({ status: 'unknown' }), undefined]
    ])('rejects a vector store with %s', (_case, value, expectedId) => {
        expect(parseAssistantVectorStore(value, expectedId)).toEqual({ success: false })
    })

    it.each([undefined, {}, [vectorStore(), vectorStore()], [vectorStore({ id: '' })]])(
        'rejects malformed or duplicate lists: %p',
        (value) => {
            expect(parseAssistantVectorStoreList(value)).toEqual({ success: false })
        }
    )

    it.each([
        [{ id: 'vs-1', deleted: true }, 'vs-1', true],
        [{ id: 'vs-2', deleted: true }, 'vs-1', false],
        [{ id: 'vs-1', deleted: false }, 'vs-1', false],
        [true, 'vs-1', false]
    ])('validates an exact delete response', (value, expectedId, expected) => {
        expect(validateAssistantVectorStoreDeletion(value, expectedId)).toBe(expected)
    })

    it('correlates mutation responses to the requested name and expiration policy', () => {
        const expectedBody = { name: '知识库', expires_after: { anchor: 'last_active_at', days: 7 } }
        expect(validateAssistantVectorStoreMutation(vectorStore(), { expectedId: 'vs-1', expectedBody }).success).toBe(true)
        expect(validateAssistantVectorStoreMutation(vectorStore({ name: '陈旧名称' }), { expectedId: 'vs-1', expectedBody })).toEqual({
            success: false
        })
        expect(validateAssistantVectorStoreMutation(vectorStore({ expires_after: null }), { expectedId: 'vs-1', expectedBody })).toEqual({
            success: false
        })
        expect(validateAssistantVectorStoreMutation(vectorStore(), { expectedId: 'vs-1', expectedBody, requireFiles: true })).toEqual({
            success: false
        })
        expect(
            validateAssistantVectorStoreMutation(vectorStore({ files: [] }), {
                expectedId: 'vs-1',
                expectedBody,
                requireFiles: true
            }).success
        ).toBe(true)
        expect(
            validateAssistantVectorStoreMutation(vectorStore({ expires_after: undefined }), {
                expectedId: 'vs-1',
                expectedBody: { name: '知识库', expires_after: null }
            }).success
        ).toBe(true)
    })
})

describe('OpenAI assistant vector-store operation identity', () => {
    const operation = {
        scopeKey: 'scope-1',
        generation: 4,
        credential: 'credential-1',
        show: true
    }

    it.each(['scopeKey', 'generation', 'credential', 'show'])('rejects completion after %s changes', (field) => {
        const current = { ...operation }
        current[field] = field === 'show' ? false : `${current[field]}-changed`
        expect(isAssistantVectorStoreOperationCurrent(operation, current)).toBe(false)
    })

    it('accepts only the unchanged visible scope', () => {
        expect(isAssistantVectorStoreOperationCurrent(operation, { ...operation })).toBe(true)
    })
})

describe('OpenAI assistant vector-store expiration input', () => {
    it.each([
        [1, 1],
        ['7', 7],
        [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
    ])('accepts positive safe integer %p', (value, expected) => {
        expect(parseAssistantVectorStoreExpirationDays(value)).toBe(expected)
    })

    it.each(['', 0, -1, 1.5, '1.5', 'not-a-number', Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid days %p', (value) => {
        expect(parseAssistantVectorStoreExpirationDays(value)).toBeNull()
    })

    it('omits an empty create name but preserves the update clear-name contract', () => {
        expect(buildAssistantVectorStoreMutationBody({ type: 'ADD', name: '', isExpirationOn: false, expirationDays: 7 })).toEqual({
            success: true,
            data: {}
        })
        expect(buildAssistantVectorStoreMutationBody({ type: 'EDIT', name: '', isExpirationOn: false, expirationDays: 7 })).toEqual({
            success: true,
            data: { name: null, expires_after: null }
        })
    })

    it('fails closed for invalid mutation type, name, or expiration days', () => {
        expect(buildAssistantVectorStoreMutationBody({ type: 'ADD', name: '', isExpirationOn: true, expirationDays: 1.5 })).toEqual({
            success: false
        })
        expect(buildAssistantVectorStoreMutationBody({ type: 'OTHER', name: '', isExpirationOn: false, expirationDays: 7 })).toEqual({
            success: false
        })
    })
})
