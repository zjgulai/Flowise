import {
    appendUploadedCodeInterpreterFiles,
    appendUploadedVectorStoreFiles,
    createAssistantScopeKey,
    hasProviderBoundAssistantState,
    INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE,
    INVALID_ASSISTANT_RESOURCE_MESSAGE,
    isAssistantOperationCurrent,
    MAX_ASSISTANT_DESCRIPTION_LENGTH,
    MAX_ASSISTANT_INSTRUCTIONS_LENGTH,
    MAX_ASSISTANT_NAME_LENGTH,
    parseAssistantDetails,
    parseAssistantSamplingParams,
    parseAssistantToolResources,
    parseOptionalAssistantNumber,
    parseStoredAssistantResource,
    removeCodeInterpreterFile,
    validateAssistantDeletionResponse,
    validateAssistantMutationResponse,
    validateAssistantTextFields
} from './assistantResourceState'

const validDetails = (overrides = {}) => ({
    id: 'asst-1',
    name: 'Assistant',
    description: null,
    model: 'gpt-4.1',
    instructions: null,
    temperature: 1,
    top_p: 1,
    tools: ['file_search'],
    tool_resources: {
        file_search: {
            vector_store_ids: ['vector-store-1'],
            files: [{ id: 'file-1', filename: 'first.txt' }],
            vector_store_object: { id: 'vector-store-1', name: 'Documents' }
        }
    },
    ...overrides
})

const storedResource = (overrides = {}) => ({
    id: 'flowise-assistant-1',
    iconSrc: 'https://example.com/icon.svg',
    credential: 'credential-1',
    type: 'OPENAI',
    details: JSON.stringify(validDetails()),
    ...overrides
})

describe('OpenAI assistant scope identity', () => {
    it('does not collide when adjacent fields contain separators', () => {
        expect(createAssistantScopeKey(['EDIT', 'assistant:one', 'details'])).not.toBe(
            createAssistantScopeKey(['EDIT:assistant', 'one', 'details'])
        )
    })

    it('treats visibility and credentials as part of the scope', () => {
        expect(createAssistantScopeKey([true, 'ADD', 'asst-1', 'credential-1'])).not.toBe(
            createAssistantScopeKey([false, 'ADD', 'asst-1', 'credential-1'])
        )
        expect(createAssistantScopeKey([true, 'ADD', 'asst-1', 'credential-1'])).not.toBe(
            createAssistantScopeKey([true, 'ADD', 'asst-1', 'credential-2'])
        )
    })

    it.each(['scope', 'scopeKey', 'generation', 'assistantId', 'openAIAssistantId', 'credential', 'show'])(
        'rejects an async completion after %s changes',
        (changedField) => {
            const scope = { id: 'assistant-1', generation: 1 }
            const operation = {
                scope,
                scopeKey: 'scope-key',
                generation: 4,
                assistantId: 'stored-1',
                openAIAssistantId: 'asst-1',
                credential: 'credential-1',
                show: true
            }
            const current = { ...operation }
            if (changedField === 'scope') current.scope = { id: 'assistant-1', generation: 2 }
            else if (changedField === 'show') current.show = false
            else current[changedField] = `${current[changedField]}-changed`

            expect(isAssistantOperationCurrent(operation, current)).toBe(false)
        }
    )

    it('accepts a completion only while the full operation identity remains current', () => {
        const operation = {
            scope: { id: 'assistant-1', generation: 1 },
            scopeKey: 'scope-key',
            generation: 4,
            assistantId: 'stored-1',
            openAIAssistantId: 'asst-1',
            credential: 'credential-1',
            show: true
        }

        expect(isAssistantOperationCurrent(operation, { ...operation })).toBe(true)
    })
})

describe('OpenAI assistant credential binding', () => {
    it.each([
        [{ openAIAssistantId: 'asst-1', toolResources: {} }, true],
        [{ openAIAssistantId: '', toolResources: { code_interpreter: { file_ids: ['file-1'], files: [{ id: 'file-1' }] } } }, true],
        [
            {
                openAIAssistantId: '',
                toolResources: { file_search: { vector_store_ids: ['vs-1'], vector_store_object: { id: 'vs-1' }, files: [] } }
            },
            true
        ],
        [{ openAIAssistantId: '', toolResources: {} }, false]
    ])('detects whether Provider resources lock the credential', (value, expected) => {
        expect(hasProviderBoundAssistantState(value)).toBe(expected)
    })
})

describe('OpenAI assistant resource parsing', () => {
    it('uses one normalized shape for stored JSON and provider objects', () => {
        const stored = parseStoredAssistantResource(storedResource({ iconSrc: null }))
        const api = parseAssistantDetails(validDetails({ tools: [{ type: 'file_search' }] }))

        expect(stored.success).toBe(true)
        expect(api.success).toBe(true)
        expect(stored.data.iconSrc).toBe('')
        expect(stored.data.details.tools).toEqual(['file_search'])
        expect(api.data.tools).toEqual(['file_search'])
        expect(stored.data.details.description).toBe('')
    })

    it('defaults both code-interpreter file collections to empty arrays', () => {
        const parsed = parseAssistantDetails(
            validDetails({
                tools: ['code_interpreter'],
                tool_resources: { code_interpreter: {} }
            })
        )

        expect(parsed.success).toBe(true)
        expect(parsed.data.tool_resources.code_interpreter).toMatchObject({ files: [], file_ids: [] })
    })

    it('accepts the documented 256000-character instruction boundary and rejects one more character', () => {
        expect(parseAssistantDetails(validDetails({ instructions: 'x'.repeat(256000) })).success).toBe(true)
        expect(parseAssistantDetails(validDetails({ instructions: 'x'.repeat(256001) }))).toEqual({ success: false })
    })

    it('validates every text limit before a mutation request is sent', () => {
        expect(
            validateAssistantTextFields({
                name: 'n'.repeat(MAX_ASSISTANT_NAME_LENGTH),
                description: 'd'.repeat(MAX_ASSISTANT_DESCRIPTION_LENGTH),
                instructions: 'i'.repeat(MAX_ASSISTANT_INSTRUCTIONS_LENGTH)
            })
        ).toBe(true)
        expect(
            validateAssistantTextFields({
                name: 'n'.repeat(MAX_ASSISTANT_NAME_LENGTH + 1),
                description: '',
                instructions: ''
            })
        ).toBe(false)
        expect(
            validateAssistantTextFields({
                name: '',
                description: 'd'.repeat(MAX_ASSISTANT_DESCRIPTION_LENGTH + 1),
                instructions: ''
            })
        ).toBe(false)
        expect(
            validateAssistantTextFields({
                name: '',
                description: '',
                instructions: 'i'.repeat(MAX_ASSISTANT_INSTRUCTIONS_LENGTH + 1)
            })
        ).toBe(false)
    })

    it.each([
        ['malformed JSON', '{'],
        ['a non-object top level', JSON.stringify(['not-an-assistant'])],
        ['an invalid nested file', JSON.stringify(validDetails({ tool_resources: { file_search: { files: [{ id: 42 }] } } }))],
        [
            'more than one vector store',
            JSON.stringify(validDetails({ tool_resources: { file_search: { vector_store_ids: ['one', 'two'] } } }))
        ],
        [
            'inconsistent vector store metadata',
            JSON.stringify(
                validDetails({
                    tool_resources: { file_search: { vector_store_ids: ['one'], vector_store_object: { id: 'two' } } }
                })
            )
        ],
        [
            'vector files without a vector store',
            JSON.stringify(validDetails({ tool_resources: { file_search: { files: [{ id: 'file-1' }] } } }))
        ],
        [
            'mismatched code-interpreter file ids',
            JSON.stringify(
                validDetails({
                    tool_resources: {
                        code_interpreter: { file_ids: ['file-1'], files: [{ id: 'file-2', filename: 'second.txt' }] }
                    }
                })
            )
        ],
        ['an out-of-range temperature', JSON.stringify(validDetails({ temperature: 3 }))],
        ['an out-of-range top-p value', JSON.stringify(validDetails({ top_p: -0.1 }))]
    ])('rejects %s without exposing parser diagnostics', (_case, details) => {
        expect(parseStoredAssistantResource(storedResource({ details }))).toEqual({ success: false })
    })

    it('rejects a non-OpenAI stored assistant', () => {
        expect(parseStoredAssistantResource(storedResource({ type: 'CUSTOM' }))).toEqual({ success: false })
    })

    it('exports fixed user-safe validation messages', () => {
        expect(INVALID_ASSISTANT_RESOURCE_MESSAGE).toBe('助手数据无效，无法加载。')
        expect(INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE).toBe('服务器返回的助手数据无效，请刷新后重试。')
    })
})

describe('OpenAI assistant mutation contracts', () => {
    const expectedDetails = validDetails()

    it('accepts a correlated create response and requires a generated non-empty id', () => {
        const result = validateAssistantMutationResponse(storedResource(), {
            expectedCredential: 'credential-1',
            expectedIcon: 'https://example.com/icon.svg',
            expectedDetails: { ...expectedDetails, id: '' }
        })

        expect(result.success).toBe(true)
        expect(result.data.id).toBe('flowise-assistant-1')
        expect(result.data.details.id).toBe('asst-1')
    })

    it('accepts an update only when both stored and provider ids are correlated', () => {
        expect(
            validateAssistantMutationResponse(storedResource(), {
                expectedAssistantId: 'flowise-assistant-1',
                expectedCredential: 'credential-1',
                expectedIcon: 'https://example.com/icon.svg',
                expectedDetails
            }).success
        ).toBe(true)
    })

    it.each([
        ['has no stored id', storedResource({ id: '' }), {}],
        ['has the wrong stored id', storedResource({ id: 'flowise-assistant-2' }), { expectedAssistantId: 'flowise-assistant-1' }],
        ['has the wrong credential', storedResource({ credential: 'credential-2' }), {}],
        ['has the wrong icon', storedResource({ iconSrc: 'https://example.com/other.svg' }), {}],
        ['has the wrong provider id', storedResource({ details: JSON.stringify(validDetails({ id: 'asst-2' })) }), {}],
        ['has the wrong model', storedResource({ details: JSON.stringify(validDetails({ model: 'gpt-4o' })) }), {}],
        ['has the wrong type', storedResource({ type: 'CUSTOM' }), {}]
    ])('rejects a response that %s', (_case, response, expectationOverrides) => {
        expect(
            validateAssistantMutationResponse(response, {
                expectedAssistantId: 'flowise-assistant-1',
                expectedCredential: 'credential-1',
                expectedIcon: 'https://example.com/icon.svg',
                expectedDetails,
                ...expectationOverrides
            })
        ).toEqual({ success: false })
    })

    it.each([
        ['an exact TypeORM result', { affected: 1 }, 'flowise-assistant-1', true],
        ['an exact deleted result', { deleted: true, id: 'flowise-assistant-1' }, 'flowise-assistant-1', true],
        ['a truthy legacy response', true, 'flowise-assistant-1', false],
        ['zero affected rows', { affected: 0 }, 'flowise-assistant-1', false],
        ['a mismatched deleted id', { deleted: true, id: 'flowise-assistant-2' }, 'flowise-assistant-1', false]
    ])('validates %s', (_case, response, expectedId, accepted) => {
        expect(validateAssistantDeletionResponse(response, expectedId)).toBe(accepted)
    })

    it.each([
        [0, 0],
        ['0', 0],
        [null, null],
        ['', null],
        ['1.25', 1.25]
    ])('preserves numeric input %p as %p', (input, expected) => {
        expect(parseOptionalAssistantNumber(input)).toBe(expected)
    })

    it.each([
        [
            { temperature: 0, topP: 0 },
            { temperature: 0, topP: 0 }
        ],
        [
            { temperature: 2, topP: 1 },
            { temperature: 2, topP: 1 }
        ],
        [
            { temperature: '', topP: '' },
            { temperature: null, topP: null }
        ],
        [
            { temperature: '1.25', topP: '0.5' },
            { temperature: 1.25, topP: 0.5 }
        ]
    ])('accepts valid sampling params %p', (input, expected) => {
        expect(parseAssistantSamplingParams(input)).toEqual({ success: true, data: expected })
    })

    it.each([
        { temperature: -0.1, topP: 0.5 },
        { temperature: 2.1, topP: 0.5 },
        { temperature: 1, topP: -0.1 },
        { temperature: 1, topP: 1.1 },
        { temperature: 'not-a-number', topP: 0.5 },
        { temperature: Infinity, topP: 0.5 }
    ])('rejects invalid sampling params %p', (input) => {
        expect(parseAssistantSamplingParams(input)).toEqual({ success: false })
    })
})

describe('OpenAI assistant code-interpreter file state', () => {
    it('validates uploaded files before atomically appending files and ids', () => {
        const result = appendUploadedCodeInterpreterFiles({
            uploadedFiles: [{ id: 'file-1', filename: 'first.txt' }],
            currentToolResources: {}
        })

        expect(result).toEqual({
            success: true,
            data: {
                code_interpreter: {
                    files: [{ id: 'file-1', filename: 'first.txt' }],
                    file_ids: ['file-1']
                }
            }
        })
    })

    it.each([undefined, {}, [], [{ id: '' }], [{ id: 'file-1' }, { id: 'file-1' }]])(
        'rejects malformed upload response %p',
        (uploadedFiles) => {
            expect(appendUploadedCodeInterpreterFiles({ uploadedFiles, currentToolResources: {} })).toEqual({ success: false })
        }
    )

    it('rejects an upload that would exceed the 20-file Provider limit without changing local state', () => {
        const existingFiles = Array.from({ length: 19 }, (_value, index) => ({ id: `file-${index}`, filename: `${index}.txt` }))
        const result = appendUploadedCodeInterpreterFiles({
            uploadedFiles: [
                { id: 'file-19', filename: '19.txt' },
                { id: 'file-20', filename: '20.txt' }
            ],
            currentToolResources: {
                code_interpreter: {
                    files: existingFiles,
                    file_ids: existingFiles.map((file) => file.id)
                }
            }
        })

        expect(result).toEqual({ success: false })
    })

    it('rejects an upload response whose file count does not match the request', () => {
        expect(
            appendUploadedCodeInterpreterFiles({
                uploadedFiles: [{ id: 'file-1' }],
                expectedFileCount: 2,
                currentToolResources: {}
            })
        ).toEqual({ success: false })
    })

    it('removes a file from both collections even when optional collections started empty', () => {
        const currentToolResources = {
            code_interpreter: {
                files: [{ id: 'file-1', filename: 'first.txt' }],
                file_ids: ['file-1']
            }
        }

        expect(removeCodeInterpreterFile({ fileId: 'file-1', currentToolResources })).toEqual({
            success: true,
            data: { code_interpreter: { files: [], file_ids: [] } }
        })
        expect(removeCodeInterpreterFile({ fileId: 'missing', currentToolResources })).toEqual({ success: false })
    })
})

describe('OpenAI assistant vector-store state', () => {
    const currentToolResources = {
        file_search: {
            vector_store_ids: ['vector-store-1'],
            files: [{ id: 'file-1', filename: 'first.txt' }],
            vector_store_object: { id: 'vector-store-1', name: 'Documents' }
        }
    }

    it('returns a committed next state only for the expected vector store', () => {
        const result = appendUploadedVectorStoreFiles({
            uploadedFiles: [{ id: 'file-2', filename: 'second.txt' }],
            vectorStoreId: 'vector-store-1',
            currentToolResources
        })

        expect(result.success).toBe(true)
        expect(result.data.file_search.files.map((file) => file.id)).toEqual(['file-1', 'file-2'])
    })

    it.each([
        ['a malformed response', { uploadedFiles: true, vectorStoreId: 'vector-store-1', currentToolResources }],
        ['a changed vector store', { uploadedFiles: [{ id: 'file-2' }], vectorStoreId: 'vector-store-2', currentToolResources }],
        ['a duplicate file', { uploadedFiles: [{ id: 'file-1' }], vectorStoreId: 'vector-store-1', currentToolResources }]
    ])('cannot report success for %s', (_case, input) => {
        expect(appendUploadedVectorStoreFiles(input)).toEqual({ success: false })
    })

    it('rejects a vector upload response whose count does not match the request', () => {
        expect(
            appendUploadedVectorStoreFiles({
                uploadedFiles: [{ id: 'file-2' }],
                expectedFileCount: 2,
                vectorStoreId: 'vector-store-1',
                currentToolResources
            })
        ).toEqual({ success: false })
    })

    it('rejects file-search state without one matching vector-store identity', () => {
        expect(
            parseAssistantToolResources({
                file_search: {
                    vector_store_ids: [],
                    files: [{ id: 'file-1' }],
                    vector_store_object: { id: 'vector-store-1' }
                }
            })
        ).toEqual({ success: false })
    })
})
