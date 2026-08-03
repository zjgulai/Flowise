const mockGetRunningExpressApp = jest.fn()
const mockLoaderInit = jest.fn()

jest.mock('flowise-components', () => ({
    addArrayFilesToStorage: jest.fn(),
    addSingleFileToStorage: jest.fn(),
    extractResponseContent: jest.fn(),
    getFileFromStorage: jest.fn(),
    getFileFromUpload: jest.fn(),
    getStorageSize: jest.fn(),
    mapExtToInputField: jest.fn(),
    mapMimeTypeToInputField: jest.fn(),
    removeFilesFromStorage: jest.fn(),
    removeSpecificFileFromStorage: jest.fn(),
    removeSpecificFileFromUpload: jest.fn(),
    resolveSafeChatModelSelection: jest.fn()
}))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: () => mockGetRunningExpressApp() }))
jest.mock('../credentials', () => ({ __esModule: true, default: { assertCredentialInWorkspace: jest.fn() } }))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))
jest.mock(
    'synthetic-document-loader-provider',
    () => ({
        nodeClass: class {
            init(...args: unknown[]) {
                return mockLoaderInit(...args)
            }
        }
    }),
    { virtual: true }
)

import { DocumentStoreStatus } from '../../Interface'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { createDocumentStoreOperationIdentity, createDocumentStoreVersionToken, parseDocumentStoreIfMatch } from './documentStoreVersion'
import documentStoreService, { processLoader } from '.'

const generationId = '11111111-1111-4111-8111-111111111111'
const componentNodes = {
    safeLoader: {
        name: 'safeLoader',
        label: 'Safe Loader',
        category: 'Document Loaders',
        baseClasses: ['Document'],
        inputs: [],
        filePath: 'synthetic-document-loader-provider'
    },
    vectorStore: {
        name: 'vectorStore',
        label: 'Vector Store',
        category: 'Vector Stores',
        baseClasses: ['VectorStoreRetriever'],
        inputs: [{ name: 'indexName' }, { name: 'namespace' }],
        filePath: 'synthetic-vector-provider'
    }
} as any

const createFixture = (vectorStoreConfig: string | null = null, status: DocumentStoreStatus = DocumentStoreStatus.UPSERTED) => {
    const entity = Object.assign(new DocumentStore(), {
        id: 'store-1',
        name: 'Store',
        description: null,
        loaders: '[]',
        whereUsed: '[]',
        status,
        vectorStoreConfig,
        embeddingConfig: null,
        recordManagerConfig: null,
        workspaceId: 'workspace-1',
        generationId,
        revision: 1
    }) as unknown as DocumentStore
    const repository = {
        findOneBy: jest.fn().mockResolvedValue(entity),
        update: jest.fn().mockResolvedValue({ affected: 1 })
    }
    const dataSource = { getRepository: jest.fn((target) => (target === DocumentStore ? repository : undefined)) } as any
    const operationIdentity = createDocumentStoreOperationIdentity(
        entity.id,
        entity.workspaceId,
        parseDocumentStoreIfMatch(createDocumentStoreVersionToken(entity))
    )
    mockGetRunningExpressApp.mockReturnValue({ AppDataSource: dataSource, nodesPool: { componentNodes } })
    return { entity, repository, dataSource, operationIdentity }
}

describe('document store materialization invalidation', () => {
    beforeEach(() => jest.clearAllMocks())

    it('marks an upserted store stale when the vector-only configuration changes', async () => {
        const { repository, operationIdentity } = createFixture()

        await expect(
            documentStoreService.updateVectorStoreConfigOnly(
                { storeId: 'store-1', vectorStoreName: 'vectorStore', vectorStoreConfig: {} },
                'workspace-1',
                operationIdentity
            )
        ).resolves.toMatchObject({ status: DocumentStoreStatus.STALE, revision: 2 })

        expect(repository.update).toHaveBeenCalledWith(
            { id: 'store-1', workspaceId: 'workspace-1', generationId, revision: 1 },
            {
                vectorStoreConfig: JSON.stringify({ config: {}, name: 'vectorStore' }),
                status: DocumentStoreStatus.STALE
            }
        )
    })

    it('marks an upserted store stale when the full vector configuration changes', async () => {
        const { repository, dataSource, operationIdentity } = createFixture()

        await expect(
            documentStoreService.saveVectorStoreConfig(
                dataSource,
                { storeId: 'store-1', vectorStoreName: 'vectorStore', vectorStoreConfig: {} },
                true,
                'workspace-1',
                false,
                operationIdentity
            )
        ).resolves.toMatchObject({ status: DocumentStoreStatus.STALE, revision: 2 })

        expect(repository.update).toHaveBeenCalledWith(
            { id: 'store-1', workspaceId: 'workspace-1', generationId, revision: 1 },
            expect.objectContaining({ status: DocumentStoreStatus.STALE })
        )
    })

    it('keeps an upserted store current when the persisted vector configuration is unchanged', async () => {
        const persisted = JSON.stringify({ config: {}, name: 'vectorStore' })
        const { repository, dataSource, operationIdentity } = createFixture(persisted)

        await expect(
            documentStoreService.saveVectorStoreConfig(
                dataSource,
                { storeId: 'store-1', vectorStoreName: 'vectorStore', vectorStoreConfig: {} },
                true,
                'workspace-1',
                false,
                operationIdentity
            )
        ).resolves.toMatchObject({ status: DocumentStoreStatus.UPSERTED, revision: 1 })

        expect(repository.update).not.toHaveBeenCalled()
    })

    it.each([DocumentStoreStatus.UPSERTED, DocumentStoreStatus.STALE, DocumentStoreStatus.UPSERTING])(
        'preserves %s and the current revision for a semantically identical vector-only configuration',
        async (status) => {
            const persisted = JSON.stringify({
                config: { namespace: 'support', indexName: 'tickets' },
                name: 'vectorStore'
            })
            const { repository, operationIdentity } = createFixture(persisted, status)

            await expect(
                documentStoreService.updateVectorStoreConfigOnly(
                    {
                        storeId: 'store-1',
                        vectorStoreName: 'vectorStore',
                        vectorStoreConfig: { indexName: 'tickets', namespace: 'support' }
                    },
                    'workspace-1',
                    operationIdentity
                )
            ).resolves.toMatchObject({ status, revision: 1, vectorStoreConfig: persisted })

            expect(repository.update).not.toHaveBeenCalled()
        }
    )

    it.each([DocumentStoreStatus.STALE, DocumentStoreStatus.UPSERTING])(
        'preserves %s for a semantically identical full vector configuration',
        async (status) => {
            const persisted = JSON.stringify({
                config: { namespace: 'support', indexName: 'tickets' },
                name: 'vectorStore'
            })
            const { repository, dataSource, operationIdentity } = createFixture(persisted, status)

            await expect(
                documentStoreService.saveVectorStoreConfig(
                    dataSource,
                    {
                        storeId: 'store-1',
                        vectorStoreName: 'vectorStore',
                        vectorStoreConfig: { indexName: 'tickets', namespace: 'support' }
                    },
                    true,
                    'workspace-1',
                    false,
                    operationIdentity
                )
            ).resolves.toMatchObject({ status, revision: 1, vectorStoreConfig: persisted })

            expect(repository.update).not.toHaveBeenCalled()
        }
    )

    it('atomically marks an upserted store stale when loader processing is claimed', async () => {
        const { entity, repository, dataSource, operationIdentity } = createFixture(null, DocumentStoreStatus.UPSERTED)

        await expect(
            documentStoreService.saveProcessingLoader(
                dataSource,
                { storeId: 'store-1', loaderId: 'safeLoader', loaderName: 'Safe Loader', loaderConfig: {} },
                'workspace-1',
                operationIdentity
            )
        ).resolves.toMatchObject({ status: DocumentStoreStatus.SYNCING, versionToken: expect.any(String) })

        expect(repository.update).toHaveBeenCalledWith(
            { id: 'store-1', workspaceId: 'workspace-1', generationId, revision: 1 },
            { loaders: expect.any(String), status: DocumentStoreStatus.STALE }
        )
        expect(entity).toMatchObject({ status: DocumentStoreStatus.STALE, revision: 2 })
    })

    it('keeps the raw parent stale when direct loader provider processing fails', async () => {
        const { entity, repository, dataSource, operationIdentity } = createFixture(null, DocumentStoreStatus.UPSERTED)
        mockLoaderInit.mockRejectedValueOnce(new Error('private provider failure'))

        await expect(
            processLoader({
                appDataSource: dataSource,
                componentNodes,
                data: { storeId: 'store-1', loaderId: 'safeLoader', loaderName: 'Safe Loader', loaderConfig: {} },
                docLoaderId: 'loader-1',
                isProcessWithoutUpsert: true,
                telemetry: {} as any,
                orgId: 'org-1',
                workspaceId: 'workspace-1',
                subscriptionId: 'subscription-1',
                usageCacheManager: {} as any,
                operationIdentity
            })
        ).rejects.toMatchObject({ statusCode: 500, message: 'Failed to split document store content' })

        expect(repository.update).toHaveBeenCalledWith(
            { id: 'store-1', workspaceId: 'workspace-1', generationId, revision: 1 },
            { status: DocumentStoreStatus.STALE }
        )
        expect(entity).toMatchObject({ status: DocumentStoreStatus.STALE, revision: 2 })
    })
})
