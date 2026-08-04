import { DocumentStoreStatus } from '../../Interface'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { createDocumentStoreOperationIdentity, createDocumentStoreVersionToken, parseDocumentStoreIfMatch } from './documentStoreVersion'

let mockCredentialShareActive = true
const mockInvoke = jest.fn(async () => ({ content: 'Generated description' }))
const mockInit = jest.fn(async (_nodeData: unknown, _input: unknown, options: Record<string, unknown>) => {
    if (options.workspaceId !== 'workspace-1' || !mockCredentialShareActive) {
        throw new Error('Credential is not available in this workspace')
    }
    return { invoke: mockInvoke }
})
const mockRetrieverInvoke = jest.fn(async () => [{ pageContent: 'first', metadata: { source: 'fixture' } }])
const mockVectorDelete = jest.fn(async (_nodeData: unknown, _ids: unknown, options: Record<string, unknown>) => {
    if (options.workspaceId !== 'workspace-1' || !mockCredentialShareActive) {
        throw new Error('Credential is not available in this workspace')
    }
})
const mockProviderInit = jest.fn(async (nodeData: Record<string, unknown>, _input: unknown, options: Record<string, unknown>) => {
    if (options.workspaceId !== 'workspace-1' || !mockCredentialShareActive) {
        throw new Error('Credential is not available in this workspace')
    }
    if (nodeData.name === 'vectorStore') return { invoke: mockRetrieverInvoke }
    return { provider: nodeData.name }
})

jest.mock(
    'workspace-scoped-chat-model',
    () => ({
        nodeClass: class {
            init(...args: [unknown, unknown, Record<string, unknown>]) {
                return mockInit(...args)
            }
        }
    }),
    { virtual: true }
)

jest.mock(
    'workspace-scoped-document-provider',
    () => ({
        nodeClass: class {
            vectorStoreMethods = { delete: mockVectorDelete }

            init(...args: [Record<string, unknown>, unknown, Record<string, unknown>]) {
                return mockProviderInit(...args)
            }
        }
    }),
    { virtual: true }
)

jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../credentials', () => ({
    __esModule: true,
    default: {
        assertCredentialInWorkspace: jest.fn(async () => {
            if (!mockCredentialShareActive) throw new Error('Credential is not available in this workspace')
        })
    }
}))

import documentStoreService from '.'

const operationIdentityFor = (generationId: string, revision = 1) =>
    createDocumentStoreOperationIdentity(
        'store-1',
        'workspace-1',
        parseDocumentStoreIfMatch(createDocumentStoreVersionToken({ id: 'store-1', workspaceId: 'workspace-1', generationId, revision }))
    )

const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const documentStoreRepository = { findOneBy: jest.fn(), update: jest.fn() }
const chunkRepository = { findBy: jest.fn(), findOneBy: jest.fn() }

const providerComponent = (name: string) => ({
    name,
    label: name,
    category: name === 'embedding' ? 'Embeddings' : name === 'vectorStore' ? 'Vector Stores' : 'Record Manager',
    baseClasses: name === 'embedding' ? ['Embeddings'] : name === 'vectorStore' ? ['VectorStoreRetriever'] : ['RecordManager'],
    credential: { name: 'credential' },
    inputs: [],
    filePath: 'workspace-scoped-document-provider'
})

describe('document store tool description service tenant and credential scoping', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCredentialShareActive = true
        documentStoreRepository.findOneBy.mockResolvedValue({ id: 'store-1', workspaceId: 'workspace-1' })
        documentStoreRepository.update.mockResolvedValue({ affected: 1 })
        chunkRepository.findBy.mockResolvedValue([
            { storeId: 'store-1', chunkNo: 2, pageContent: 'second' },
            { storeId: 'store-1', chunkNo: 1, pageContent: 'first' }
        ])
        chunkRepository.findOneBy.mockResolvedValue({ id: 'chunk-1', chunkNo: 1 })
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository: jest.fn((entity) => {
                    if (entity === DocumentStore) return documentStoreRepository
                    if (entity === DocumentStoreFileChunk) return chunkRepository
                    throw new Error('Unexpected repository')
                })
            },
            nodesPool: {
                componentNodes: {
                    chatModel: {
                        name: 'chatModel',
                        category: 'Chat Models',
                        baseClasses: ['BaseChatModel'],
                        inputs: [],
                        filePath: 'workspace-scoped-chat-model'
                    },
                    embedding: providerComponent('embedding'),
                    vectorStore: providerComponent('vectorStore'),
                    recordManager: providerComponent('recordManager')
                }
            }
        })
    })

    const selectedChatModel = {
        name: 'chatModel',
        credential: 'credential-1',
        inputs: { FLOWISE_CREDENTIAL_ID: 'credential-1' }
    }

    it('checks store ownership before reading chunks and scopes model credentials to the same workspace', async () => {
        await expect(documentStoreService.generateDocStoreToolDesc('store-1', selectedChatModel, 'workspace-1')).resolves.toEqual({
            content: 'Generated description'
        })

        expect(documentStoreRepository.findOneBy).toHaveBeenCalledWith({ id: 'store-1', workspaceId: 'workspace-1' })
        expect(chunkRepository.findBy).toHaveBeenCalledWith({ storeId: 'store-1' })
        expect(documentStoreRepository.findOneBy.mock.invocationCallOrder[0]).toBeLessThan(
            chunkRepository.findBy.mock.invocationCallOrder[0]
        )
        expect(mockInit).toHaveBeenCalledWith(
            expect.objectContaining({ credential: 'credential-1' }),
            '',
            expect.objectContaining({ workspaceId: 'workspace-1' })
        )
    })

    it('does not read chunks or initialize a model for a cross-workspace store ID', async () => {
        documentStoreRepository.findOneBy.mockResolvedValue(null)

        await expect(documentStoreService.generateDocStoreToolDesc('store-other', selectedChatModel, 'workspace-1')).rejects.toMatchObject({
            statusCode: 404,
            message: 'Document store not found'
        })

        expect(chunkRepository.findBy).not.toHaveBeenCalled()
        expect(mockInit).not.toHaveBeenCalled()
    })

    it('fails closed before any repository access without a workspace', async () => {
        await expect(documentStoreService.generateDocStoreToolDesc('store-1', selectedChatModel, '')).rejects.toMatchObject({
            statusCode: 403
        })

        expect(documentStoreRepository.findOneBy).not.toHaveBeenCalled()
        expect(chunkRepository.findBy).not.toHaveBeenCalled()
        expect(mockInit).not.toHaveBeenCalled()
    })

    it('rechecks credential access on every generation and blocks immediately after share revocation', async () => {
        await expect(documentStoreService.generateDocStoreToolDesc('store-1', selectedChatModel, 'workspace-1')).resolves.toEqual({
            content: 'Generated description'
        })

        mockCredentialShareActive = false

        await expect(documentStoreService.generateDocStoreToolDesc('store-1', selectedChatModel, 'workspace-1')).rejects.toMatchObject({
            statusCode: 404
        })
        expect(mockInit).toHaveBeenCalledTimes(1)
        expect(mockInvoke).toHaveBeenCalledTimes(1)
    })

    it('scopes vector store queries and chunk correlation to an owned store', async () => {
        documentStoreRepository.findOneBy.mockResolvedValue({
            id: 'store-1',
            workspaceId: 'workspace-1',
            generationId: '11111111-1111-4111-8111-111111111111',
            revision: 1,
            status: 'UPSERTED',
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } })
        })

        await expect(
            documentStoreService.queryVectorStore({ storeId: 'store-1', query: 'support policy' }, 'workspace-1')
        ).resolves.toEqual(
            expect.objectContaining({ docs: [{ pageContent: 'first', metadata: { source: 'fixture' }, id: 'chunk-1', chunkNo: 1 }] })
        )

        expect(documentStoreRepository.findOneBy).toHaveBeenCalledWith({ id: 'store-1', workspaceId: 'workspace-1' })
        expect(mockProviderInit).toHaveBeenCalledTimes(2)
        for (const call of mockProviderInit.mock.calls) {
            expect(call[2]).toEqual(expect.objectContaining({ workspaceId: 'workspace-1' }))
        }
        expect(chunkRepository.findOneBy).toHaveBeenCalledWith({ storeId: 'store-1', pageContent: 'first' })
    })

    it('does not initialize query providers for a cross-workspace store ID', async () => {
        documentStoreRepository.findOneBy.mockResolvedValue(null)

        await expect(
            documentStoreService.queryVectorStore({ storeId: 'store-other', query: 'support policy' }, 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 404, message: 'Document store not found' })
        expect(mockProviderInit).not.toHaveBeenCalled()
        expect(chunkRepository.findOneBy).not.toHaveBeenCalled()
    })

    it.each([DocumentStoreStatus.SYNC, DocumentStoreStatus.STALE, DocumentStoreStatus.UPSERTING])(
        'rejects a %s store before reading persisted configuration or initializing providers',
        async (status) => {
            const embeddingConfigGetter = jest.fn(() => {
                throw new Error('persisted embedding configuration must not be read')
            })
            const vectorStoreConfigGetter = jest.fn(() => {
                throw new Error('persisted vector configuration must not be read')
            })
            const entity = { id: 'store-1', workspaceId: 'workspace-1', status }
            Object.defineProperty(entity, 'embeddingConfig', { enumerable: true, get: embeddingConfigGetter })
            Object.defineProperty(entity, 'vectorStoreConfig', { enumerable: true, get: vectorStoreConfigGetter })
            documentStoreRepository.findOneBy.mockResolvedValue(entity)

            await expect(
                documentStoreService.queryVectorStore({ storeId: 'store-1', query: 'support policy' }, 'workspace-1')
            ).rejects.toMatchObject({ statusCode: 409, message: 'Document store vector index is not available' })

            expect(embeddingConfigGetter).not.toHaveBeenCalled()
            expect(vectorStoreConfigGetter).not.toHaveBeenCalled()
            expect(mockProviderInit).not.toHaveBeenCalled()
            expect(mockRetrieverInvoke).not.toHaveBeenCalled()
            expect(chunkRepository.findOneBy).not.toHaveBeenCalled()
        }
    )

    it('blocks vector store queries after a credential share is revoked', async () => {
        documentStoreRepository.findOneBy.mockResolvedValue({
            id: 'store-1',
            workspaceId: 'workspace-1',
            status: DocumentStoreStatus.UPSERTED,
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } })
        })

        await documentStoreService.queryVectorStore({ storeId: 'store-1', query: 'support policy' }, 'workspace-1')
        mockCredentialShareActive = false

        await expect(
            documentStoreService.queryVectorStore({ storeId: 'store-1', query: 'support policy' }, 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 404 })
        expect(mockRetrieverInvoke).toHaveBeenCalledTimes(1)
    })

    it('does not invoke provider getters and drops over-broad query metadata before descriptor traversal', async () => {
        const pageContentGetter = jest.fn(() => {
            throw new Error('provider page getter must not run')
        })
        const metadataGetter = jest.fn(() => {
            throw new Error('provider metadata getter must not run')
        })
        const resultGetTrap = jest.fn(Reflect.get)
        const metadataDescriptorTrap = jest.fn(Reflect.getOwnPropertyDescriptor)
        const maliciousDocument = {}
        Object.defineProperty(maliciousDocument, 'pageContent', { enumerable: true, get: pageContentGetter })
        Object.defineProperty(maliciousDocument, 'metadata', { enumerable: true, get: metadataGetter })

        const metadataTarget: Record<string, unknown> = {}
        for (let index = 0; index < 512; index += 1) metadataTarget[`field-${index}`] = index
        Object.defineProperty(metadataTarget, 'providerSecret', { enumerable: true, get: metadataGetter })
        const metadata = new Proxy(metadataTarget, { getOwnPropertyDescriptor: metadataDescriptorTrap })
        const safeDocument = new Proxy({ pageContent: 'safe content', metadata }, { get: resultGetTrap })
        mockRetrieverInvoke.mockResolvedValueOnce([maliciousDocument, safeDocument])
        documentStoreRepository.findOneBy.mockResolvedValue({
            id: 'store-1',
            workspaceId: 'workspace-1',
            status: DocumentStoreStatus.UPSERTED,
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } })
        })

        await expect(
            documentStoreService.queryVectorStore({ storeId: 'store-1', query: 'support policy' }, 'workspace-1')
        ).resolves.toMatchObject({
            docs: [{ pageContent: 'safe content', metadata: {}, id: 'chunk-1', chunkNo: 1 }]
        })

        expect(pageContentGetter).not.toHaveBeenCalled()
        expect(metadataGetter).not.toHaveBeenCalled()
        expect(resultGetTrap).not.toHaveBeenCalled()
        expect(metadataDescriptorTrap).not.toHaveBeenCalled()
    })

    it('caps provider query results before chunk correlation', async () => {
        mockRetrieverInvoke.mockResolvedValueOnce(
            Array.from({ length: 125 }, (_, index) => ({
                pageContent: `content-${index}`,
                metadata: { source: 'fixture', index }
            }))
        )
        documentStoreRepository.findOneBy.mockResolvedValue({
            id: 'store-1',
            workspaceId: 'workspace-1',
            status: DocumentStoreStatus.UPSERTED,
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } })
        })

        await expect(
            documentStoreService.queryVectorStore({ storeId: 'store-1', query: 'support policy' }, 'workspace-1')
        ).resolves.toMatchObject({ docs: expect.any(Array) })

        expect(chunkRepository.findOneBy).toHaveBeenCalledTimes(100)
        expect(chunkRepository.findOneBy).not.toHaveBeenCalledWith({ storeId: 'store-1', pageContent: 'content-100' })
    })

    it('returns a fixed query failure without exposing provider details', async () => {
        mockRetrieverInvoke.mockRejectedValueOnce(new Error('private provider query detail'))
        documentStoreRepository.findOneBy.mockResolvedValue({
            id: 'store-1',
            workspaceId: 'workspace-1',
            status: DocumentStoreStatus.UPSERTED,
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } })
        })

        await expect(
            documentStoreService.queryVectorStore({ storeId: 'store-1', query: 'support policy' }, 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 500, message: 'Document store query failed' })
        expect(chunkRepository.findOneBy).not.toHaveBeenCalled()
    })

    it('rejects a forged persisted delete component before CAS or provider import', async () => {
        const ownedEntity = {
            id: 'store-1',
            workspaceId: 'workspace-1',
            generationId: '11111111-1111-4111-8111-111111111111',
            revision: 1,
            status: DocumentStoreStatus.UPSERTED,
            embeddingConfig: JSON.stringify({ name: 'chatModel', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } }),
            recordManagerConfig: JSON.stringify({ name: 'recordManager', config: { credential: 'credential-1' } })
        }
        documentStoreRepository.findOneBy.mockResolvedValue(ownedEntity)

        await expect(
            documentStoreService.deleteVectorStoreFromStore(
                'store-1',
                'workspace-1',
                undefined,
                operationIdentityFor(ownedEntity.generationId)
            )
        ).rejects.toMatchObject({ statusCode: 400, message: 'Invalid document store component selection' })

        expect(documentStoreRepository.update).not.toHaveBeenCalled()
        expect(mockProviderInit).not.toHaveBeenCalled()
        expect(mockVectorDelete).not.toHaveBeenCalled()
    })

    it('rejects a stale imported materialization before provider validation or deletion', async () => {
        const ownedEntity = {
            id: 'store-1',
            workspaceId: 'workspace-1',
            generationId: '11111111-1111-4111-8111-111111111111',
            revision: 1,
            status: DocumentStoreStatus.STALE,
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } }),
            recordManagerConfig: JSON.stringify({ name: 'recordManager', config: { credential: 'credential-1' } })
        }
        documentStoreRepository.findOneBy.mockResolvedValue(ownedEntity)

        await expect(
            documentStoreService.deleteVectorStoreFromStore(
                'store-1',
                'workspace-1',
                undefined,
                operationIdentityFor(ownedEntity.generationId)
            )
        ).rejects.toMatchObject({ statusCode: 409, message: 'Document store vector index is not available' })

        expect(documentStoreRepository.update).not.toHaveBeenCalled()
        expect(mockProviderInit).not.toHaveBeenCalled()
        expect(mockVectorDelete).not.toHaveBeenCalled()
    })

    it('passes workspaceId through record manager, embedding and vector delete execution', async () => {
        documentStoreRepository.findOneBy.mockResolvedValue({
            id: 'store-1',
            workspaceId: 'workspace-1',
            generationId: '11111111-1111-4111-8111-111111111111',
            revision: 1,
            status: 'UPSERTED',
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } }),
            recordManagerConfig: JSON.stringify({ name: 'recordManager', config: { credential: 'credential-1' } })
        })

        await expect(
            documentStoreService.deleteVectorStoreFromStore(
                'store-1',
                'workspace-1',
                undefined,
                operationIdentityFor('11111111-1111-4111-8111-111111111111')
            )
        ).resolves.toMatchObject({ deleted: true, versionToken: expect.any(String) })

        expect(mockProviderInit).toHaveBeenCalledTimes(2)
        expect(mockVectorDelete).toHaveBeenCalledWith(expect.anything(), [], expect.objectContaining({ workspaceId: 'workspace-1' }))
    })

    it('rejects a same-ID replacement generation before vector provider initialization', async () => {
        documentStoreRepository.findOneBy.mockResolvedValue({
            id: 'store-1',
            workspaceId: 'workspace-1',
            generationId: '22222222-2222-4222-8222-222222222222',
            revision: 1,
            status: 'UPSERTED',
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } }),
            recordManagerConfig: JSON.stringify({ name: 'recordManager', config: { credential: 'credential-1' } })
        })

        await expect(
            documentStoreService.deleteVectorStoreFromStore(
                'store-1',
                'workspace-1',
                undefined,
                operationIdentityFor('11111111-1111-4111-8111-111111111111')
            )
        ).rejects.toMatchObject({ statusCode: 409, message: 'Document store vector state changed concurrently' })

        expect(documentStoreRepository.update).not.toHaveBeenCalled()
        expect(mockProviderInit).not.toHaveBeenCalled()
        expect(mockVectorDelete).not.toHaveBeenCalled()
    })

    it('rejects an old digest whose visible revision was edited to the current value', async () => {
        const generationId = '11111111-1111-4111-8111-111111111111'
        documentStoreRepository.findOneBy.mockResolvedValue({
            id: 'store-1',
            workspaceId: 'workspace-1',
            generationId,
            revision: 2,
            status: 'UPSERTED',
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } }),
            recordManagerConfig: JSON.stringify({ name: 'recordManager', config: { credential: 'credential-1' } })
        })
        const forgedIdentity = operationIdentityFor(generationId, 1)
        forgedIdentity.revision = 2

        await expect(
            documentStoreService.deleteVectorStoreFromStore('store-1', 'workspace-1', undefined, forgedIdentity)
        ).rejects.toMatchObject({ statusCode: 409, message: 'Document store vector state changed concurrently' })

        expect(documentStoreRepository.update).not.toHaveBeenCalled()
        expect(mockProviderInit).not.toHaveBeenCalled()
        expect(mockVectorDelete).not.toHaveBeenCalled()
    })

    it('uses the exact claimed lifetime and revision for failure recovery instead of adopting a fresh row', async () => {
        const ownedEntity = {
            id: 'store-1',
            workspaceId: 'workspace-1',
            generationId: '11111111-1111-4111-8111-111111111111',
            revision: 1,
            status: 'UPSERTED',
            embeddingConfig: JSON.stringify({ name: 'embedding', config: { credential: 'credential-1' } }),
            vectorStoreConfig: JSON.stringify({ name: 'vectorStore', config: { credential: 'credential-1' } }),
            recordManagerConfig: JSON.stringify({ name: 'recordManager', config: { credential: 'credential-1' } })
        }
        documentStoreRepository.findOneBy.mockResolvedValue(ownedEntity)
        documentStoreRepository.update.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 })
        mockVectorDelete.mockRejectedValueOnce(new Error('private provider detail'))

        await expect(
            documentStoreService.deleteVectorStoreFromStore(
                'store-1',
                'workspace-1',
                undefined,
                operationIdentityFor(ownedEntity.generationId)
            )
        ).rejects.toMatchObject({ statusCode: 409, message: 'Document store vector state changed concurrently' })

        expect(documentStoreRepository.update).toHaveBeenNthCalledWith(
            2,
            { id: 'store-1', workspaceId: 'workspace-1', generationId: ownedEntity.generationId, revision: 2 },
            { status: 'STALE' }
        )
    })
})
