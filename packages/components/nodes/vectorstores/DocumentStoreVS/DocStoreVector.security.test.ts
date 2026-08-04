export {}

const mockEmbeddingModuleLoad = jest.fn()
const mockVectorStoreModuleLoad = jest.fn()
const mockEmbeddingInit = jest.fn().mockResolvedValue({ kind: 'embedding' })
const mockVectorStoreInit = jest.fn().mockResolvedValue({ kind: 'retriever' })

jest.mock(
    'doc-store-embedding-test-provider',
    () => {
        mockEmbeddingModuleLoad()
        return {
            nodeClass: class {
                init(...args: unknown[]) {
                    return mockEmbeddingInit(...args)
                }
            }
        }
    },
    { virtual: true }
)

jest.mock(
    'doc-store-vector-test-provider',
    () => {
        mockVectorStoreModuleLoad()
        return {
            nodeClass: class {
                init(...args: unknown[]) {
                    return mockVectorStoreInit(...args)
                }
            }
        }
    },
    { virtual: true }
)

const { nodeClass: DocStoreVector } = require('./DocStoreVector')

const validStore = {
    id: 'store-a',
    workspaceId: 'workspace-a',
    status: 'UPSERTED',
    embeddingConfig: JSON.stringify({ name: 'testEmbedding', config: { credential: 'embedding-credential' } }),
    vectorStoreConfig: JSON.stringify({ name: 'testVectorStore', config: { credential: 'vector-credential' } })
}

const makeHarness = (
    store: Record<string, unknown> | null = null,
    accessibleCredentialIds: ReadonlySet<string> = new Set(['embedding-credential', 'vector-credential'])
) => {
    const storeRepository = {
        findOneBy: jest.fn(async ({ id, workspaceId }: { id: string; workspaceId: string }) =>
            store?.id === id && store?.workspaceId === workspaceId ? store : null
        )
    }
    const credentialRepository = {
        findOneBy: jest.fn(async ({ id, workspaceId }: { id: string; workspaceId?: string }) =>
            accessibleCredentialIds.has(id) && (!workspaceId || workspaceId === 'workspace-a') ? { id, workspaceId: 'workspace-a' } : null
        )
    }
    const sharedRepository = { findOneBy: jest.fn().mockResolvedValue(null) }
    const appDataSource = {
        getRepository: jest.fn((entity) => {
            if (entity === 'DocumentStoreEntity') return storeRepository
            if (entity === 'CredentialEntity') return credentialRepository
            if (entity === 'WorkspaceSharedEntity') return sharedRepository
            throw new Error('Unexpected repository')
        })
    }
    return {
        storeRepository,
        credentialRepository,
        sharedRepository,
        options: {
            workspaceId: 'workspace-a',
            appDataSource,
            databaseEntities: {
                DocumentStore: 'DocumentStoreEntity',
                Credential: 'CredentialEntity',
                WorkspaceShared: 'WorkspaceSharedEntity'
            },
            componentNodes: {
                testEmbedding: {
                    name: 'testEmbedding',
                    label: 'Test embedding',
                    category: 'Embeddings',
                    baseClasses: ['Embeddings'],
                    credential: { name: 'credential' },
                    inputs: [],
                    filePath: 'doc-store-embedding-test-provider'
                },
                testVectorStore: {
                    name: 'testVectorStore',
                    label: 'Test vector store',
                    category: 'Vector Stores',
                    baseClasses: ['VectorStoreRetriever'],
                    credential: { name: 'credential' },
                    inputs: [],
                    filePath: 'doc-store-vector-test-provider'
                }
            }
        }
    }
}

describe('Document Store vector runtime tenant boundary', () => {
    beforeEach(() => jest.clearAllMocks())

    it.each([undefined, '', '   '])('rejects a missing workspace before parent or provider access (%p)', async (workspaceId) => {
        const harness = makeHarness()
        const node = new DocStoreVector()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', { ...harness.options, workspaceId })).rejects.toThrow(
            'Document Store workspace context is required'
        )
        expect(harness.options.appDataSource.getRepository).not.toHaveBeenCalled()
        expect(mockEmbeddingModuleLoad).not.toHaveBeenCalled()
        expect(mockVectorStoreModuleLoad).not.toHaveBeenCalled()
        expect(mockEmbeddingInit).not.toHaveBeenCalled()
        expect(mockVectorStoreInit).not.toHaveBeenCalled()
    })

    it('uses a scoped parent lookup and exposes no foreign-store detail or provider side effect', async () => {
        const harness = makeHarness({ ...validStore, workspaceId: 'workspace-b' })
        const node = new DocStoreVector()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', harness.options)).rejects.toThrow(
            'Document Store is unavailable'
        )
        expect(harness.storeRepository.findOneBy).toHaveBeenCalledWith({ id: 'store-a', workspaceId: 'workspace-a' })
        expect(mockEmbeddingModuleLoad).not.toHaveBeenCalled()
        expect(mockVectorStoreModuleLoad).not.toHaveBeenCalled()
        expect(mockEmbeddingInit).not.toHaveBeenCalled()
        expect(mockVectorStoreInit).not.toHaveBeenCalled()
    })

    it.each([
        { label: 'wrong state', store: { ...validStore, status: 'SYNC' } },
        { label: 'missing embedding config', store: { ...validStore, embeddingConfig: null } },
        { label: 'invalid vector config', store: { ...validStore, vectorStoreConfig: '{invalid' } }
    ])('rejects $label before importing or initializing a provider', async ({ store }) => {
        const harness = makeHarness(store as Record<string, unknown>)
        const node = new DocStoreVector()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', harness.options)).rejects.toThrow(
            'Document Store is unavailable'
        )
        expect(mockEmbeddingModuleLoad).not.toHaveBeenCalled()
        expect(mockVectorStoreModuleLoad).not.toHaveBeenCalled()
        expect(mockEmbeddingInit).not.toHaveBeenCalled()
        expect(mockVectorStoreInit).not.toHaveBeenCalled()
    })

    it.each([
        {
            label: 'wrong embedding category',
            mutate: (harness: ReturnType<typeof makeHarness>) => {
                harness.options.componentNodes.testEmbedding.category = 'Tools'
            }
        },
        {
            label: 'wrong vector base class',
            mutate: (harness: ReturnType<typeof makeHarness>) => {
                harness.options.componentNodes.testVectorStore.baseClasses = ['Tool']
            }
        }
    ])('rejects $label before importing a forged runtime component', async ({ mutate }) => {
        const harness = makeHarness(validStore)
        mutate(harness)
        const node = new DocStoreVector()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', harness.options)).rejects.toThrow(
            'Document Store is unavailable'
        )
        expect(mockEmbeddingModuleLoad).not.toHaveBeenCalled()
        expect(mockVectorStoreModuleLoad).not.toHaveBeenCalled()
        expect(mockEmbeddingInit).not.toHaveBeenCalled()
        expect(mockVectorStoreInit).not.toHaveBeenCalled()
    })

    it('rejects an unallowlisted persisted config field before provider import', async () => {
        const harness = makeHarness({
            ...validStore,
            embeddingConfig: JSON.stringify({
                name: 'testEmbedding',
                config: { credential: 'embedding-credential', customFunction: 'return process.env' }
            })
        })
        const node = new DocStoreVector()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', harness.options)).rejects.toThrow(
            'Document Store is unavailable'
        )
        expect(mockEmbeddingModuleLoad).not.toHaveBeenCalled()
        expect(mockVectorStoreModuleLoad).not.toHaveBeenCalled()
    })

    it('rejects a credential outside the active workspace before provider import', async () => {
        const harness = makeHarness(validStore, new Set())
        const node = new DocStoreVector()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', harness.options)).rejects.toThrow(
            'Document Store is unavailable'
        )
        expect(harness.credentialRepository.findOneBy).toHaveBeenCalledWith({
            id: 'embedding-credential',
            workspaceId: 'workspace-a'
        })
        expect(mockEmbeddingModuleLoad).not.toHaveBeenCalled()
        expect(mockVectorStoreModuleLoad).not.toHaveBeenCalled()
        expect(mockEmbeddingInit).not.toHaveBeenCalled()
        expect(mockVectorStoreInit).not.toHaveBeenCalled()
    })

    it('initializes configured providers only after a same-workspace upserted parent is verified', async () => {
        const harness = makeHarness(validStore)
        const node = new DocStoreVector()

        await expect(
            node.init({ inputs: { selectedStore: ' store-a ' }, outputs: { output: 'retriever' } }, '', harness.options)
        ).resolves.toEqual({ kind: 'retriever' })

        expect(harness.storeRepository.findOneBy).toHaveBeenCalledWith({ id: 'store-a', workspaceId: 'workspace-a' })
        expect(mockEmbeddingModuleLoad).toHaveBeenCalledTimes(1)
        expect(mockVectorStoreModuleLoad).toHaveBeenCalledTimes(1)
        expect(mockEmbeddingInit).toHaveBeenCalledTimes(1)
        expect(mockVectorStoreInit).toHaveBeenCalledWith(
            expect.objectContaining({
                inputs: expect.objectContaining({ embeddings: { kind: 'embedding' } }),
                outputs: { output: 'retriever' }
            }),
            '',
            harness.options
        )
    })
})
