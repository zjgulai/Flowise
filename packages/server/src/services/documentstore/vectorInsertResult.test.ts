let providerResult: unknown
const mockVectorUpsert = jest.fn(async () => providerResult)
const mockTelemetry = { sendTelemetry: jest.fn() }
const mockGetRunningExpressApp = jest.fn()

jest.mock(
    'synthetic-embedding-provider',
    () => ({
        nodeClass: class {
            init() {
                return { embedQuery: jest.fn() }
            }
        }
    }),
    { virtual: true }
)
jest.mock(
    'synthetic-vector-provider',
    () => ({
        nodeClass: class {
            vectorStoreMethods = { upsert: mockVectorUpsert }
        }
    }),
    { virtual: true }
)
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
jest.mock('../../utils', () => ({
    databaseEntities: {},
    getAppVersion: jest.fn().mockResolvedValue('test'),
    saveUpsertFlowData: jest.fn().mockReturnValue('{}')
}))

import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { UpsertHistory } from '../../database/entities/UpsertHistory'
import { DocumentStoreStatus } from '../../Interface'
import { createDocumentStoreOperationIdentity, createDocumentStoreVersionToken, parseDocumentStoreIfMatch } from './documentStoreVersion'
import { createSafeVectorStoreResult, insertIntoVectorStore } from '.'

const generationId = '11111111-1111-4111-8111-111111111111'
const componentNodes = {
    embedding: {
        name: 'embedding',
        label: 'Embedding',
        category: 'Embeddings',
        baseClasses: ['Embeddings'],
        inputs: [],
        filePath: 'synthetic-embedding-provider'
    },
    vectorStore: {
        name: 'vectorStore',
        label: 'Vector Store',
        category: 'Vector Stores',
        baseClasses: ['VectorStoreRetriever'],
        inputs: [],
        filePath: 'synthetic-vector-provider'
    }
} as any

const runVectorInsert = (result: unknown) => {
    providerResult = result
    const entity = Object.assign(new DocumentStore(), {
        id: 'store-1',
        name: 'Store',
        description: null,
        loaders: '[]',
        whereUsed: '[]',
        status: DocumentStoreStatus.SYNC,
        vectorStoreConfig: null,
        embeddingConfig: null,
        recordManagerConfig: null,
        workspaceId: 'workspace-1',
        generationId,
        revision: 1
    })
    const documentStoreRepository = {
        findOneBy: jest.fn().mockImplementation(async () => entity),
        update: jest.fn().mockResolvedValue({ affected: 1 })
    }
    const chunkRepository = { find: jest.fn().mockResolvedValue([]) }
    const historyRepository = { create: jest.fn((value) => value), save: jest.fn().mockResolvedValue(undefined) }
    const getRepository = (target: unknown) => {
        if (target === DocumentStore) return documentStoreRepository
        if (target === DocumentStoreFileChunk) return chunkRepository
        if (target === UpsertHistory) return historyRepository
        throw new Error('unexpected repository')
    }
    const appDataSource = {
        getRepository,
        transaction: async (callback: (manager: { getRepository: typeof getRepository }) => unknown) => callback({ getRepository })
    } as any
    mockGetRunningExpressApp.mockReturnValue({ nodesPool: { componentNodes } })
    const versionIdentity = { id: 'store-1', workspaceId: 'workspace-1', generationId, revision: 1 }
    const operationIdentity = createDocumentStoreOperationIdentity(
        versionIdentity.id,
        versionIdentity.workspaceId,
        parseDocumentStoreIfMatch(createDocumentStoreVersionToken(versionIdentity))
    )

    const promise = insertIntoVectorStore({
        appDataSource,
        componentNodes,
        telemetry: mockTelemetry as any,
        data: {
            storeId: 'store-1',
            embeddingName: 'embedding',
            embeddingConfig: {},
            vectorStoreName: 'vectorStore',
            vectorStoreConfig: {}
        },
        isStrictSave: true,
        isVectorStoreInsert: true,
        orgId: 'org-1',
        workspaceId: 'workspace-1',
        subscriptionId: 'subscription-1',
        usageCacheManager: {} as any,
        operationIdentity
    })
    return { promise, documentStoreRepository, historyRepository, operationIdentity }
}

describe('document store vector insert safe response', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockTelemetry.sendTelemetry.mockResolvedValue(undefined)
    })

    it.each([undefined, 'provider-primitive'])('commits the final parent CAS and returns fallback plus token for %p', async (result) => {
        const { promise, documentStoreRepository, operationIdentity } = runVectorInsert(result)

        await expect(promise).resolves.toEqual({
            result: 'Successfully Upserted',
            versionToken: createDocumentStoreVersionToken({
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId,
                revision: 4
            })
        })

        expect(documentStoreRepository.update).toHaveBeenCalledTimes(3)
        expect(operationIdentity.revision).toBe(4)
        expect(mockVectorUpsert).toHaveBeenCalledTimes(1)
    })

    it('returns a fixed insertion failure without serializing provider details', async () => {
        mockVectorUpsert.mockRejectedValueOnce(new Error('https://provider.invalid/path?token=private-sentinel'))
        const { promise } = runVectorInsert(undefined)
        const failure = await promise.catch((error) => error)

        expect(failure).toMatchObject({ statusCode: 500, message: 'Document store vector insertion failed' })
        expect(JSON.stringify({ statusCode: failure.statusCode, message: failure.message })).not.toContain('private-sentinel')
    })

    it('persists and emits only allowlisted numeric stats without invoking provider getters', async () => {
        const topLevelGetter = jest.fn(() => {
            throw new Error('top-level getter must not run')
        })
        const telemetryGetter = jest.fn(() => {
            throw new Error('telemetry getter must not run')
        })
        const telemetryResult = { numUpdated: 1, providerSecret: 'telemetry-secret' }
        Object.defineProperty(telemetryResult, 'numDeleted', { enumerable: true, get: telemetryGetter })
        const result = {
            numAdded: 2,
            providerSecret: 'history-secret',
            result: telemetryResult
        }
        Object.defineProperty(result, 'numSkipped', { enumerable: true, get: topLevelGetter })
        const { promise, historyRepository } = runVectorInsert(result)

        await expect(promise).resolves.toMatchObject({ numAdded: 2, versionToken: expect.any(String) })

        expect(historyRepository.create).toHaveBeenCalledWith(expect.objectContaining({ result: JSON.stringify({ numAdded: 2 }) }))
        expect(mockTelemetry.sendTelemetry).toHaveBeenCalledWith(
            'vector_upserted',
            expect.objectContaining({ flowGraph: { numUpdated: 1 } }),
            'org-1'
        )
        expect(topLevelGetter).not.toHaveBeenCalled()
        expect(telemetryGetter).not.toHaveBeenCalled()
        expect(JSON.stringify(historyRepository.create.mock.calls)).not.toContain('history-secret')
        expect(JSON.stringify(mockTelemetry.sendTelemetry.mock.calls)).not.toContain('telemetry-secret')
    })

    it('drops over-broad provider metadata before reading any property descriptor or getter', () => {
        const getter = jest.fn(() => {
            throw new Error('provider getter must not run')
        })
        const descriptorTrap = jest.fn(Reflect.getOwnPropertyDescriptor)
        const metadataTarget: Record<string, unknown> = {}
        for (let index = 0; index < 512; index += 1) metadataTarget[`field-${index}`] = index
        Object.defineProperty(metadataTarget, 'providerSecret', { enumerable: true, get: getter })
        const metadata = new Proxy(metadataTarget, { getOwnPropertyDescriptor: descriptorTrap })

        expect(
            createSafeVectorStoreResult({
                addedDocs: [{ pageContent: 'safe content', metadata }]
            })
        ).toEqual({ addedDocs: [{ pageContent: 'safe content', metadata: {} }] })
        expect(descriptorTrap).not.toHaveBeenCalled()
        expect(getter).not.toHaveBeenCalled()
    })
})
