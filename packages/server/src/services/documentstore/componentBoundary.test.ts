import documentStoreService, { createSafeVectorStoreResult, previewChunks, resolveSafeDocumentStoreComponent } from '.'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { In } from 'typeorm'

const mockInit = jest.fn()
const mockGetFileFromStorage = jest.fn()
const mockCredentialCheck = jest.fn()
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock

jest.mock(
    'malicious-document-loader',
    () => ({
        nodeClass: class {
            init(...args: unknown[]) {
                return mockInit(...args)
            }
        }
    }),
    { virtual: true }
)

jest.mock('flowise-components', () => ({
    addArrayFilesToStorage: jest.fn(),
    addSingleFileToStorage: jest.fn(),
    extractResponseContent: jest.fn(),
    getFileFromStorage: (...args: unknown[]) => mockGetFileFromStorage(...args),
    getFileFromUpload: jest.fn(),
    getStorageSize: jest.fn(),
    mapExtToInputField: jest.fn(),
    mapMimeTypeToInputField: jest.fn(),
    removeFilesFromStorage: jest.fn(),
    removeSpecificFileFromStorage: jest.fn(),
    removeSpecificFileFromUpload: jest.fn(),
    resolveSafeChatModelSelection: jest.fn()
}))
jest.mock('../credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: (...args: unknown[]) => mockCredentialCheck(...args) }
}))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }))

const loader = (name: string, inputs: string[] = []) => ({
    name,
    label: name,
    category: 'Document Loaders',
    baseClasses: ['Document'],
    inputs: inputs.map((input) => ({ name: input })),
    filePath: 'malicious-document-loader'
})

const dataSource = { getRepository: jest.fn() } as any

describe('document store component execution boundary', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it.each([
        ['folderFiles', { folderPath: '.' }],
        ['documentStore', { selectedStore: 'external-workspace-store' }],
        ['vectorStoreToDocument', { vectorStore: 'attacker-store' }],
        ['unstructuredFolderLoader', { folderPath: '/etc' }]
    ])('denies hidden loader %s before database, filesystem, import, init, or network access', async (name, loaderConfig) => {
        const componentNodes = { [name]: loader(name, Object.keys(loaderConfig)) } as any

        await expect(
            previewChunks({
                appDataSource: dataSource,
                componentNodes,
                data: { loaderId: name, loaderConfig } as any,
                orgId: 'org-1',
                workspaceId: 'workspace-1'
            } as any)
        ).rejects.toMatchObject({ statusCode: 400 })

        expect(dataSource.getRepository).not.toHaveBeenCalled()
        expect(mockGetFileFromStorage).not.toHaveBeenCalled()
        expect(mockInit).not.toHaveBeenCalled()
        expect(mockCredentialCheck).not.toHaveBeenCalled()
    })

    it('rejects customFunction even when a forged loader metadata record declares it', async () => {
        const componentNodes = { customLoader: loader('customLoader', ['customFunction']) } as any

        expect(() =>
            resolveSafeDocumentStoreComponent(
                componentNodes,
                'customLoader',
                { customFunction: 'return process.cwd()' },
                'Document Loaders'
            )
        ).toThrow(expect.objectContaining({ statusCode: 400 }))
        expect(mockInit).not.toHaveBeenCalled()
    })

    it('rejects a category-confused splitter before loader initialization', async () => {
        const componentNodes = {
            safeLoader: loader('safeLoader'),
            fakeSplitter: {
                name: 'fakeSplitter',
                category: 'Tools',
                baseClasses: ['TextSplitter'],
                inputs: [],
                filePath: 'malicious-document-loader'
            }
        } as any

        await expect(
            previewChunks({
                appDataSource: dataSource,
                componentNodes,
                data: {
                    loaderId: 'safeLoader',
                    loaderConfig: {},
                    splitterId: 'fakeSplitter',
                    splitterConfig: {}
                },
                orgId: 'org-1',
                workspaceId: 'workspace-1'
            } as any)
        ).rejects.toMatchObject({ statusCode: 400 })
        expect(mockInit).not.toHaveBeenCalled()
    })

    it('accepts the production-listed Meilisearch BaseRetriever metadata for vector store operations', () => {
        const meilisearch = {
            name: 'meilisearch',
            category: 'Vector Stores',
            baseClasses: ['BaseRetriever'],
            credential: { name: 'credential' },
            inputs: ['document', 'embeddings', 'host', 'indexUid', 'deleteIndex', 'K', 'semanticRatio', 'searchFilter'].map((name) => ({
                name
            })),
            filePath: '/nodes/vectorstores/Meilisearch/Meilisearch.ts'
        }

        expect(
            resolveSafeDocumentStoreComponent(
                { meilisearch } as any,
                'meilisearch',
                { credential: 'credential-id', host: 'https://search.example.invalid', indexUid: 'knowledge' },
                'Vector Stores'
            )
        ).toBe(meilisearch)
    })

    it.each([
        ['documentStoreVS', []],
        ['memoryVectorStore', []],
        ['llamaIndexVectorStore', ['LlamaIndex']]
    ])('rejects vector store provider %s excluded from the production provider list', (name, tags) => {
        const component = {
            name,
            category: 'Vector Stores',
            baseClasses: ['VectorStoreRetriever'],
            tags,
            inputs: [],
            filePath: '/synthetic/vector-store.ts'
        }

        expect(() => resolveSafeDocumentStoreComponent({ [name]: component } as any, name, {}, 'Vector Stores')).toThrow(
            expect.objectContaining({ statusCode: 400 })
        )
    })

    it('batches exported document chunks below SQLite bind-variable limits', async () => {
        const find = jest.fn().mockResolvedValue([])
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository: (entity: unknown) => {
                    expect(entity).toBe(DocumentStoreFileChunk)
                    return { find }
                }
            }
        })
        const storeIds = Array.from({ length: 1001 }, (_, index) => `store-${index}`)

        await expect(documentStoreService.getAllDocumentFileChunksByDocumentStoreIds(storeIds)).resolves.toEqual([])

        expect(find).toHaveBeenCalledTimes(3)
        for (const [index, batch] of [storeIds.slice(0, 400), storeIds.slice(400, 800), storeIds.slice(800)].entries()) {
            expect(find.mock.calls[index][0]).toEqual({ where: { storeId: In(batch) }, order: { id: 'ASC' }, take: 10_001 })
        }
    })

    it('fails before materializing more than the document-chunk export cap', async () => {
        const find = jest.fn().mockResolvedValue(Array.from({ length: 10_001 }, (_, index) => ({ id: `chunk-${index}` })))
        mockGetRunningExpressApp.mockReturnValue({ AppDataSource: { getRepository: () => ({ find }) } })

        await expect(documentStoreService.getAllDocumentFileChunksByDocumentStoreIds(['store-1'])).rejects.toMatchObject({
            statusCode: 422
        })
        expect(find).toHaveBeenCalledWith({ where: { storeId: In(['store-1']) }, order: { id: 'ASC' }, take: 10_001 })
    })

    it('preserves Document class results through an own-field allowlist without invoking getters or leaking extras', () => {
        class DocumentLike {
            pageContent = 'visible content'
            metadata = { source: 'fixture' }
            providerSecret = 'must not leak'
        }
        const getter = jest.fn(() => {
            throw new Error('getter must not run')
        })
        const malicious = {}
        Object.defineProperty(malicious, 'pageContent', { enumerable: true, get: getter })
        Object.defineProperty(malicious, 'metadata', { enumerable: true, get: getter })

        const result = createSafeVectorStoreResult({
            numAdded: 2,
            totalKeys: 999,
            providerSecret: 'must not leak',
            addedDocs: [new DocumentLike(), malicious]
        })

        expect(result).toEqual({
            numAdded: 2,
            addedDocs: [
                { pageContent: 'visible content', metadata: { source: 'fixture' } },
                { pageContent: '', metadata: {} }
            ]
        })
        expect(getter).not.toHaveBeenCalled()
        expect(JSON.stringify(result)).not.toContain('must not leak')
        expect(result).not.toHaveProperty('totalKeys')
    })

    it('bounds nested metadata, drops cycles and accessors, and never throws on a hostile provider result', () => {
        const nestedGetter = jest.fn(() => {
            throw new Error('nested getter must not run')
        })
        const topLevelGetter = jest.fn(() => {
            throw new Error('top-level getter must not run')
        })
        const addedDocsGetter = jest.fn(() => {
            throw new Error('addedDocs getter must not run')
        })
        const nestedMetadata: Record<string, unknown> = { safe: 'visible' }
        Object.defineProperty(nestedMetadata, 'secret', { enumerable: true, get: nestedGetter })
        const circularMetadata: Record<string, unknown> = { safe: 'cycle-visible' }
        circularMetadata.self = circularMetadata
        const deepMetadata: Record<string, unknown> = {}
        let cursor = deepMetadata
        for (let depth = 0; depth < 16; depth += 1) {
            const next: Record<string, unknown> = {}
            cursor.next = next
            cursor = next
        }
        cursor.terminalSecret = 'too-deep'
        const providerResult = {
            numAdded: 3,
            addedDocs: [
                { pageContent: 'nested', metadata: { nested: nestedMetadata } },
                { pageContent: 'circular', metadata: circularMetadata },
                { pageContent: 'deep', metadata: deepMetadata }
            ]
        }
        Object.defineProperty(providerResult, 'numDeleted', { enumerable: true, get: topLevelGetter })

        const result = createSafeVectorStoreResult(providerResult)

        expect(result).toMatchObject({
            numAdded: 3,
            addedDocs: [
                { pageContent: 'nested', metadata: { nested: { safe: 'visible' } } },
                { pageContent: 'circular', metadata: { safe: 'cycle-visible' } },
                { pageContent: 'deep', metadata: expect.any(Object) }
            ]
        })
        expect(nestedGetter).not.toHaveBeenCalled()
        expect(topLevelGetter).not.toHaveBeenCalled()
        expect(JSON.stringify(result)).not.toContain('too-deep')

        const accessorResult = {}
        Object.defineProperty(accessorResult, 'addedDocs', { enumerable: true, get: addedDocsGetter })
        expect(createSafeVectorStoreResult(accessorResult)).toEqual({ result: 'Successfully Upserted' })
        expect(addedDocsGetter).not.toHaveBeenCalled()

        const revoked = Proxy.revocable({}, {})
        revoked.revoke()
        expect(createSafeVectorStoreResult(revoked.proxy)).toEqual({ result: 'Successfully Upserted' })
    })
})
