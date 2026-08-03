import { StatusCodes } from 'http-status-codes'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import {
    applyDocumentStoreUsageReferencesForImport,
    insertDocumentStoreChunksForImport,
    insertDocumentStoresForImport,
    preflightDocumentStoreReferencesForImport,
    rebuildDocumentStoreUsageForImport,
    remapDocumentStoreIdsForImport,
    sanitizeDocumentStoresForImport
} from './documentStoreImport'

describe('document store import revision ownership', () => {
    it('rebuilds all server-owned state without mutating the source payload', () => {
        const source = [
            {
                id: 'store-1',
                name: 'Synthetic',
                description: 'Imported description',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 2_147_483_647,
                versionToken: 'attacker-selected',
                status: 'UPSERTED',
                loaders:
                    '[{"id":"attacker-loader","loaderId":"customFunction","loaderName":"Forged","loaderConfig":{"customFunction":"return process.env"},"totalChunks":1,"totalChars":10,"status":"SYNC","storeId":"foreign-store","source":"forged","versionToken":"forged"}]',
                whereUsed: '["attacker-flow"]',
                embeddingConfig: '{"name":"customFunction","config":{}}',
                vectorStoreConfig: '{"name":"customFunction","config":{}}',
                recordManagerConfig: '{"name":"customFunction","config":{}}'
            }
        ]

        const [sanitized] = sanitizeDocumentStoresForImport(source)

        expect(sanitized).toEqual({
            id: 'store-1',
            name: 'Synthetic',
            description: 'Imported description',
            workspaceId: 'workspace-1',
            generationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            loaders: expect.any(String),
            whereUsed: '[]',
            status: 'STALE',
            embeddingConfig: '{"name":"customFunction","config":{}}',
            vectorStoreConfig: '{"name":"customFunction","config":{}}',
            recordManagerConfig: '{"name":"customFunction","config":{}}'
        })
        expect(JSON.parse(sanitized.loaders)).toEqual([
            {
                id: 'attacker-loader',
                loaderId: 'customFunction',
                loaderName: 'Forged',
                loaderConfig: { customFunction: 'return process.env' },
                totalChunks: 1,
                totalChars: 10,
                status: 'STALE'
            }
        ])
        expect(source[0]).toEqual({
            id: 'store-1',
            name: 'Synthetic',
            description: 'Imported description',
            workspaceId: 'workspace-1',
            generationId: '11111111-1111-4111-8111-111111111111',
            revision: 2_147_483_647,
            versionToken: 'attacker-selected',
            status: 'UPSERTED',
            loaders:
                '[{"id":"attacker-loader","loaderId":"customFunction","loaderName":"Forged","loaderConfig":{"customFunction":"return process.env"},"totalChunks":1,"totalChars":10,"status":"SYNC","storeId":"foreign-store","source":"forged","versionToken":"forged"}]',
            whereUsed: '["attacker-flow"]',
            embeddingConfig: '{"name":"customFunction","config":{}}',
            vectorStoreConfig: '{"name":"customFunction","config":{}}',
            recordManagerConfig: '{"name":"customFunction","config":{}}'
        })
    })

    it.each([
        null,
        { id: '', name: 'Synthetic', workspaceId: 'workspace-1' },
        { id: 'store-1', name: '   ', workspaceId: 'workspace-1' },
        { id: 'store-1', name: 'Synthetic', workspaceId: '', description: null },
        { id: 'store-1', name: 'Synthetic', workspaceId: 'workspace-1', description: {} },
        { id: 'store-1', name: 'x'.repeat(256), workspaceId: 'workspace-1', loaders: '[]' },
        { id: 'store-1', name: 'Synthetic', workspaceId: 'workspace-1', loaders: '[{"id":"loader-only"}]' }
    ])('rejects an invalid document store import shape (%p)', (source) => {
        expect(() => sanitizeDocumentStoresForImport([source])).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST, message: 'Invalid document store import' })
        )
    })

    it('rebuilds whereUsed from finalized imported flow references and ignores unknown stores', () => {
        const stores = [
            { id: 'store-a', whereUsed: '["attacker"]' },
            { id: 'store-b', whereUsed: '["attacker"]' }
        ] as DocumentStore[]

        expect(
            rebuildDocumentStoreUsageForImport(stores, [
                { id: 'flow-1', documentStoreIds: ['store-a', 'store-a', 'unknown'] },
                { id: 'flow-2', documentStoreIds: ['store-a', 'store-b'] }
            ])
        ).toEqual([
            { id: 'store-a', whereUsed: '["flow-1","flow-2"]' },
            { id: 'store-b', whereUsed: '["flow-2"]' }
        ])
        expect(stores).toEqual([
            { id: 'store-a', whereUsed: '["attacker"]' },
            { id: 'store-b', whereUsed: '["attacker"]' }
        ])
    })

    it('regenerates every imported ID and remaps exact structured references without corrupting user text', () => {
        const first = '11111111-1111-4111-8111-111111111111'
        const second = '22222222-2222-4222-8222-222222222222'
        const formattedJsonWithoutReference = '{\n  "label": "keep formatting"\n}'
        const jsonUserContentWithReferences = JSON.stringify({ exact: first, nested: [second] })
        const source = {
            DocumentStore: [
                { id: first, loaders: '[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]' },
                { id: second, loaders: '[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]' }
            ],
            DocumentStoreFileChunk: [
                {
                    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    docId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    storeId: first,
                    chunkNo: 1,
                    pageContent: jsonUserContentWithReferences,
                    metadata: jsonUserContentWithReferences
                },
                {
                    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                    docId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    storeId: second,
                    chunkNo: 1,
                    pageContent: formattedJsonWithoutReference,
                    metadata: '{}'
                }
            ],
            ChatFlow: [
                {
                    flowData: JSON.stringify({
                        nodes: [
                            {
                                data: {
                                    name: 'documentStoreVS',
                                    inputs: { selectedStore: `  ${first}  `, userText: jsonUserContentWithReferences }
                                }
                            },
                            {
                                data: {
                                    name: 'agentAgentflow',
                                    inputs: { agentKnowledgeDocumentStores: [{ documentStore: `  ${second} :Knowledge  ` }] }
                                }
                            }
                        ],
                        exactUserField: first
                    })
                }
            ],
            AssistantCustom: [
                {
                    details: JSON.stringify({
                        documentStores: [{ id: first, name: 'Store' }],
                        instruction: jsonUserContentWithReferences
                    })
                }
            ],
            CustomTemplate: [
                {
                    flowData: JSON.stringify({
                        nodes: [{ data: { name: 'documentStore', inputs: { selectedStore: second } } }],
                        edges: []
                    })
                }
            ],
            ChatMessage: [{ content: jsonUserContentWithReferences }],
            Variable: [{ value: jsonUserContentWithReferences }],
            keyed: { [first]: 'object key is not a reference' }
        }

        const { data, idMap } = remapDocumentStoreIdsForImport(source, [first, second])

        expect(idMap.get(first)).toMatch(/^[0-9a-f-]{36}$/)
        expect(idMap.get(second)).toMatch(/^[0-9a-f-]{36}$/)
        expect(idMap.get(first)).not.toBe(idMap.get(second))
        expect(data.DocumentStore).toEqual([
            { id: idMap.get(first), loaders: '[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]' },
            { id: idMap.get(second), loaders: '[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]' }
        ])
        expect(data.DocumentStoreFileChunk[0]).toMatchObject({
            id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            docId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            storeId: idMap.get(first),
            chunkNo: 1,
            pageContent: jsonUserContentWithReferences,
            metadata: jsonUserContentWithReferences
        })
        expect(data.DocumentStoreFileChunk[1]).toMatchObject({
            id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            docId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            storeId: idMap.get(second),
            chunkNo: 1,
            pageContent: formattedJsonWithoutReference,
            metadata: '{}'
        })
        expect(data.DocumentStoreFileChunk[0].id).not.toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
        const remappedFlow = JSON.parse(data.ChatFlow[0].flowData)
        expect(remappedFlow.nodes[0].data.inputs).toEqual({
            selectedStore: idMap.get(first),
            userText: jsonUserContentWithReferences
        })
        expect(remappedFlow.nodes[1].data.inputs.agentKnowledgeDocumentStores).toEqual([
            { documentStore: `${idMap.get(second)}:Knowledge` }
        ])
        expect(remappedFlow.exactUserField).toBe(first)
        expect(JSON.parse(data.AssistantCustom[0].details)).toEqual({
            documentStores: [{ id: idMap.get(first), name: 'Store' }],
            instruction: jsonUserContentWithReferences
        })
        expect(JSON.parse(data.CustomTemplate[0].flowData).nodes[0].data.inputs.selectedStore).toBe(idMap.get(second))
        expect(data.ChatMessage[0].content).toBe(jsonUserContentWithReferences)
        expect(data.Variable[0].value).toBe(jsonUserContentWithReferences)
        expect(data.keyed).toEqual({ [first]: 'object key is not a reference' })
        expect(source.DocumentStore).toEqual([
            { id: first, loaders: '[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]' },
            { id: second, loaders: '[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]' }
        ])
        expect(source.DocumentStoreFileChunk[1].pageContent).toBe(formattedJsonWithoutReference)
    })

    it.each([
        [
            'a chunk without an imported store',
            [],
            [
                {
                    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    docId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    storeId: '11111111-1111-4111-8111-111111111111',
                    chunkNo: 1,
                    pageContent: 'content',
                    metadata: '{}'
                }
            ]
        ],
        [
            'a foreign store reference',
            [{ id: '11111111-1111-4111-8111-111111111111', loaders: '[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]' }],
            [
                {
                    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    docId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    storeId: '22222222-2222-4222-8222-222222222222',
                    chunkNo: 1,
                    pageContent: 'content',
                    metadata: '{}'
                }
            ]
        ],
        [
            'a mismatched loader reference',
            [{ id: '11111111-1111-4111-8111-111111111111', loaders: '[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]' }],
            [
                {
                    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    docId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    storeId: '11111111-1111-4111-8111-111111111111',
                    chunkNo: 1,
                    pageContent: 'content',
                    metadata: '{}'
                }
            ]
        ]
    ])('rejects %s before persistence', (_label, stores, chunks) => {
        expect(() =>
            remapDocumentStoreIdsForImport(
                { DocumentStore: stores, DocumentStoreFileChunk: chunks },
                stores.map((store) => store.id)
            )
        ).toThrow(expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST, message: 'Invalid document store import' }))
    })

    it('rejects duplicate source chunk IDs and duplicate store-loader positions', () => {
        const storeId = '11111111-1111-4111-8111-111111111111'
        const docId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        const base = {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            docId,
            storeId,
            chunkNo: 1,
            pageContent: 'content',
            metadata: '{}'
        }
        expect(() =>
            remapDocumentStoreIdsForImport(
                {
                    DocumentStore: [{ id: storeId, loaders: JSON.stringify([{ id: docId }]) }],
                    DocumentStoreFileChunk: [base, { ...base }]
                },
                [storeId]
            )
        ).toThrow(expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST }))
    })

    it('uses insert-only persistence so a post-preflight ID race cannot update an existing row', async () => {
        const manager = {
            insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'store-1' }] }),
            save: jest.fn()
        }
        const documentStores = [{ id: 'store-1', name: 'Synthetic' }] as DocumentStore[]

        await insertDocumentStoresForImport(manager as never, documentStores)

        expect(manager.insert).toHaveBeenCalledWith(DocumentStore, documentStores)
        expect(manager.save).not.toHaveBeenCalled()
    })

    it('regenerates chunk IDs and persists chunks with insert-only batches', async () => {
        const manager = { insert: jest.fn().mockResolvedValue({ identifiers: [] }), save: jest.fn() }
        const chunks = [{ id: 'fresh', storeId: 'store', docId: 'doc', chunkNo: 1, pageContent: 'content', metadata: '{}' }]

        await insertDocumentStoreChunksForImport(manager as never, chunks as DocumentStoreFileChunk[])

        expect(manager.insert).toHaveBeenCalledWith(DocumentStoreFileChunk, chunks)
        expect(manager.save).not.toHaveBeenCalled()
    })

    it('rebuilds imported-store usage without consulting existing workspace rows', async () => {
        const manager = {
            find: jest.fn(),
            connection: { options: { type: 'sqlite' } }
        }
        const stores = [{ id: 'new-store', whereUsed: '[]' }] as DocumentStore[]

        const rebuilt = await preflightDocumentStoreReferencesForImport(
            manager as never,
            stores,
            [{ id: 'flow-1', documentStoreIds: ['new-store'] }],
            [],
            'workspace-1'
        )

        expect(rebuilt).toEqual([{ id: 'new-store', whereUsed: '["flow-1"]' }])
        expect(manager.find).not.toHaveBeenCalled()
    })

    it('rejects references to pre-existing document stores without reading or mutating them', async () => {
        const manager = { find: jest.fn(), getRepository: jest.fn() }

        await expect(
            applyDocumentStoreUsageReferencesForImport(
                manager as never,
                [{ id: 'flow-1', documentStoreIds: ['existing-store'] }],
                [],
                'workspace-1'
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST, message: 'Invalid document store import' })
        expect(manager.find).not.toHaveBeenCalled()
        expect(manager.getRepository).not.toHaveBeenCalled()
    })

    it.each([
        ['Postgres', { code: '23505' }],
        ['SQLite', { code: 'SQLITE_CONSTRAINT', message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: document_store.id' }],
        ['MySQL/MariaDB', { driverError: { code: 'ER_DUP_ENTRY', errno: 1062 } }]
    ])('maps a %s unique-key race to a fixed conflict without database details', async (_dialect, databaseError) => {
        const manager = { insert: jest.fn().mockRejectedValue(databaseError) }

        await expect(
            insertDocumentStoresForImport(manager as never, [{ id: 'store-1', name: 'Synthetic' }] as DocumentStore[])
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Document store import changed concurrently' })
    })

    it('does not misclassify an unrelated SQLite constraint as an ID race', async () => {
        const databaseError = { code: 'SQLITE_CONSTRAINT', message: 'SQLITE_CONSTRAINT: NOT NULL constraint failed: document_store.name' }
        const manager = { insert: jest.fn().mockRejectedValue(databaseError) }

        await expect(insertDocumentStoresForImport(manager as never, [{ id: 'store-1', name: '' }] as DocumentStore[])).rejects.toBe(
            databaseError
        )
    })
})
