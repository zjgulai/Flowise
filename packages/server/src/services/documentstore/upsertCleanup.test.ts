const mockAddArrayFilesToStorage = jest.fn()
const mockGetFileFromUpload = jest.fn()
const mockMapExtToInputField = jest.fn()
const mockMapMimeTypeToInputField = jest.fn()
const mockRemoveFilesFromStorage = jest.fn()
const mockRemoveSpecificFileFromUpload = jest.fn()
const mockUpdateStorageUsage = jest.fn()
const mockCheckStorage = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('flowise-components', () => ({
    addArrayFilesToStorage: (...args: unknown[]) => mockAddArrayFilesToStorage(...args),
    addSingleFileToStorage: jest.fn(),
    extractResponseContent: jest.fn(),
    getFileFromStorage: jest.fn(),
    getFileFromUpload: (...args: unknown[]) => mockGetFileFromUpload(...args),
    getStorageSize: jest.fn(),
    mapExtToInputField: (...args: unknown[]) => mockMapExtToInputField(...args),
    mapMimeTypeToInputField: (...args: unknown[]) => mockMapMimeTypeToInputField(...args),
    removeFilesFromStorage: (...args: unknown[]) => mockRemoveFilesFromStorage(...args),
    removeSpecificFileFromStorage: jest.fn(),
    removeSpecificFileFromUpload: (...args: unknown[]) => mockRemoveSpecificFileFromUpload(...args),
    resolveSafeChatModelSelection: jest.fn()
}))
jest.mock('../../utils/fileValidation', () => ({ validateFileMimeTypeAndExtensionMatch: jest.fn() }))
jest.mock('../../utils/quotaUsage', () => ({
    checkStorage: (...args: unknown[]) => mockCheckStorage(...args),
    updateStorageUsage: (...args: unknown[]) => mockUpdateStorageUsage(...args)
}))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { error: (...args: unknown[]) => mockLoggerError(...args), warn: jest.fn(), debug: jest.fn() }
}))
jest.mock('../credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: jest.fn() }
}))

import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { UpsertHistory } from '../../database/entities/UpsertHistory'
import { createDocumentStoreOperationIdentity, createDocumentStoreVersionToken, parseDocumentStoreIfMatch } from './documentStoreVersion'
import {
    executeDocStoreUpsert,
    handleCreatedDocumentStoreFailure,
    resolveDocumentStoreFileInputField,
    resolveSafeDocumentStoreComponent
} from '.'

const component = (name: string, category: string, baseClass: string) => ({
    name,
    label: name,
    category,
    baseClasses: [baseClass],
    inputs: [],
    filePath: `${name}-component`
})

const safeComponents = {
    safeLoader: component('safeLoader', 'Document Loaders', 'Document'),
    safeEmbedding: component('safeEmbedding', 'Embeddings', 'Embeddings'),
    safeVectorStore: component('safeVectorStore', 'Vector Stores', 'VectorStoreRetriever'),
    safeRecordManager: component('safeRecordManager', 'Record Manager', 'RecordManager')
} as any

const files = [
    { path: '/tmp/first', originalname: 'first.txt', mimetype: 'text/plain' },
    { path: '/tmp/second', originalname: 'second.txt', mimetype: 'text/plain' }
] as Express.Multer.File[]

const CREATED_GENERATION_ID = '33333333-3333-4333-8333-333333333333'
const operationIdentityForCreatedStore = (revision = 1) =>
    createDocumentStoreOperationIdentity(
        'created-store',
        'workspace-1',
        parseDocumentStoreIfMatch(
            createDocumentStoreVersionToken({
                id: 'created-store',
                workspaceId: 'workspace-1',
                generationId: CREATED_GENERATION_ID,
                revision
            })
        )
    )

const createDataSource = (seedCreatedStore = false) => {
    let persistedDocumentStore: any = seedCreatedStore
        ? { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, status: 'EMPTY', revision: 1 }
        : undefined
    const documentStoreRepository = {
        create: jest.fn((value) => value),
        save: jest.fn(async (value) => {
            persistedDocumentStore = { ...value, id: 'created-store', revision: 1 }
            return persistedDocumentStore
        }),
        delete: jest.fn(async (where) => {
            const affected =
                persistedDocumentStore &&
                persistedDocumentStore.id === where.id &&
                persistedDocumentStore.workspaceId === where.workspaceId &&
                persistedDocumentStore.generationId === where.generationId &&
                persistedDocumentStore.revision === where.revision
                    ? 1
                    : 0
            if (affected) persistedDocumentStore = undefined
            return { affected }
        }),
        update: jest.fn(async (where, patch) => {
            const affected =
                persistedDocumentStore &&
                persistedDocumentStore.id === where.id &&
                persistedDocumentStore.workspaceId === where.workspaceId &&
                persistedDocumentStore.generationId === where.generationId &&
                persistedDocumentStore.revision === where.revision
                    ? 1
                    : 0
            if (affected) persistedDocumentStore = { ...persistedDocumentStore, ...patch, revision: persistedDocumentStore.revision + 1 }
            return { affected }
        }),
        findOneBy: jest.fn(async () => persistedDocumentStore)
    }
    const chunkRepository = { delete: jest.fn(async () => ({ affected: 1 })) }
    const upsertHistoryRepository = { delete: jest.fn(async () => ({ affected: 1 })) }
    return {
        dataSource: {
            getRepository: jest.fn((entity: unknown) => {
                if (entity === DocumentStoreFileChunk) return chunkRepository
                if (entity === UpsertHistory) return upsertHistoryRepository
                return documentStoreRepository
            }),
            transaction: jest.fn(async (callback) =>
                callback({
                    getRepository: (entity: unknown) => {
                        if (entity === DocumentStoreFileChunk) return chunkRepository
                        if (entity === UpsertHistory) return upsertHistoryRepository
                        return documentStoreRepository
                    }
                })
            )
        } as any,
        documentStoreRepository,
        chunkRepository,
        upsertHistoryRepository
    }
}

const execute = (overrides: Record<string, unknown> = {}) => {
    const { dataSource, documentStoreRepository, chunkRepository, upsertHistoryRepository } = createDataSource()
    const promise = executeDocStoreUpsert({
        appDataSource: dataSource,
        componentNodes: safeComponents,
        telemetry: {} as any,
        storeId: '',
        totalItems: [
            {
                createNewDocStore: true,
                docStore: { name: 'New store' },
                loader: { name: 'safeLoader', config: {} },
                embedding: { name: 'safeEmbedding', config: {} },
                vectorStore: { name: 'safeVectorStore', config: {} },
                recordManager: { name: 'safeRecordManager', config: {} }
            }
        ],
        files,
        isRefreshAPI: false,
        orgId: 'org-1',
        workspaceId: 'workspace-1',
        subscriptionId: 'subscription-1',
        usageCacheManager: {} as any,
        ...overrides
    } as any)
    return { promise, documentStoreRepository, chunkRepository, upsertHistoryRepository }
}

describe('document store upsert upload ownership and compensation', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockMapExtToInputField.mockReturnValue('txtFile')
        mockMapMimeTypeToInputField.mockReturnValue('txtFile')
        mockRemoveSpecificFileFromUpload.mockResolvedValue(undefined)
        mockRemoveFilesFromStorage.mockResolvedValue({ totalSize: 1 })
        mockUpdateStorageUsage.mockResolvedValue(undefined)
        mockCheckStorage.mockResolvedValue(undefined)
        mockAddArrayFilesToStorage.mockResolvedValue({ totalSize: 1 })
    })

    it('uses a MIME-only loader mapping when the extension falls back to txtFile', () => {
        mockMapMimeTypeToInputField.mockReturnValueOnce('pdfFile')

        expect(resolveDocumentStoreFileInputField('application/pdf', 'extensionless', 'safeLoader')).toBe('pdfFile')
        expect(mockMapExtToInputField).toHaveBeenCalledWith('')
        expect(mockMapMimeTypeToInputField).toHaveBeenCalledWith('application/pdf')
    })

    it('accepts an omitted optional record manager represented by an empty config', async () => {
        mockGetFileFromUpload.mockRejectedValueOnce(new Error('stop after component validation'))
        const { promise, documentStoreRepository } = execute({
            totalItems: [
                {
                    createNewDocStore: true,
                    docStore: { name: 'New store' },
                    loader: { name: 'safeLoader', config: {} },
                    embedding: { name: 'safeEmbedding', config: {} },
                    vectorStore: { name: 'safeVectorStore', config: {} }
                }
            ]
        })

        await expect(promise).rejects.toMatchObject({ statusCode: 500, message: 'Document store upsert failed' })
        expect(documentStoreRepository.save).toHaveBeenCalled()
    })

    it('ignores client primary and concurrency identity when upsert creates a store', async () => {
        mockGetFileFromUpload.mockRejectedValueOnce(new Error('stop after create'))
        const { promise, documentStoreRepository } = execute({
            totalItems: [
                {
                    createNewDocStore: true,
                    docStore: {
                        id: 'attacker-id',
                        name: 'New store',
                        generationId: '99999999-9999-4999-8999-999999999999',
                        revision: 999,
                        versionToken: 'attacker-token'
                    },
                    loader: { name: 'safeLoader', config: {} },
                    embedding: { name: 'safeEmbedding', config: {} },
                    vectorStore: { name: 'safeVectorStore', config: {} },
                    recordManager: { name: 'safeRecordManager', config: {} }
                }
            ]
        })

        await expect(promise).rejects.toMatchObject({ statusCode: 500 })
        expect(documentStoreRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'New store',
                workspaceId: 'workspace-1',
                generationId: expect.stringMatching(/^[0-9a-f-]{36}$/)
            })
        )
        expect(documentStoreRepository.create.mock.calls[0][0]).not.toHaveProperty('id')
        expect(documentStoreRepository.create.mock.calls[0][0]).not.toHaveProperty('revision')
        expect(documentStoreRepository.create.mock.calls[0][0]).not.toHaveProperty('versionToken')
        expect(documentStoreRepository.create.mock.calls[0][0].generationId).not.toBe('99999999-9999-4999-8999-999999999999')
    })

    it('cleans every unique path exactly once when component validation fails before file processing', async () => {
        const duplicateFiles = [files[0], files[0], files[1]]
        const deniedComponents = {
            ...safeComponents,
            folderFiles: component('folderFiles', 'Document Loaders', 'Document')
        }
        const { promise, documentStoreRepository } = execute({
            componentNodes: deniedComponents,
            files: duplicateFiles,
            totalItems: [
                {
                    createNewDocStore: true,
                    loader: { name: 'folderFiles', config: {} },
                    embedding: { name: 'safeEmbedding', config: {} },
                    vectorStore: { name: 'safeVectorStore', config: {} }
                }
            ]
        })

        await expect(promise).rejects.toMatchObject({ statusCode: 400 })

        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/first')
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/second')
        expect(documentStoreRepository.save).not.toHaveBeenCalled()
    })

    it('cleans unprocessed files and compensates the scoped new store after a mid-loop failure', async () => {
        expect(() => resolveSafeDocumentStoreComponent(safeComponents, 'safeLoader', {}, 'Document Loaders')).not.toThrow()
        expect(() => resolveSafeDocumentStoreComponent(safeComponents, 'safeEmbedding', {}, 'Embeddings')).not.toThrow()
        expect(() => resolveSafeDocumentStoreComponent(safeComponents, 'safeVectorStore', {}, 'Vector Stores')).not.toThrow()
        expect(() => resolveSafeDocumentStoreComponent(safeComponents, 'safeRecordManager', {}, 'Record Manager')).not.toThrow()
        mockGetFileFromUpload.mockResolvedValueOnce(Buffer.from('first')).mockRejectedValueOnce(new Error('second file failed'))
        const { promise, documentStoreRepository, chunkRepository, upsertHistoryRepository } = execute()

        await expect(promise).rejects.toMatchObject({ statusCode: 500, message: 'Document store upsert failed' })

        expect(mockAddArrayFilesToStorage).toHaveBeenCalledTimes(1)
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(documentStoreRepository.delete).toHaveBeenCalledWith({
            id: 'created-store',
            workspaceId: 'workspace-1',
            generationId: expect.any(String),
            revision: 1
        })
        expect(chunkRepository.delete).toHaveBeenCalledWith({ storeId: 'created-store' })
        expect(upsertHistoryRepository.delete).toHaveBeenCalledWith({ chatflowid: 'created-store' })
        expect(mockRemoveFilesFromStorage).toHaveBeenCalledWith('org-1', 'docustore', 'created-store')
    })

    it('lets a ledger cleanup failure override an earlier validation error with a fixed 500', async () => {
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('private temp path'))
        const deniedComponents = {
            ...safeComponents,
            folderFiles: component('folderFiles', 'Document Loaders', 'Document')
        }
        const { promise } = execute({
            componentNodes: deniedComponents,
            totalItems: [
                {
                    createNewDocStore: true,
                    loader: { name: 'folderFiles', config: {} },
                    embedding: { name: 'safeEmbedding', config: {} },
                    vectorStore: { name: 'safeVectorStore', config: {} }
                }
            ]
        })

        await expect(promise).rejects.toMatchObject({ statusCode: 500, message: 'Document store upload cleanup failed' })
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_upload_cleanup_failed', { failedCount: 1, totalCount: 2 })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('private temp path')
    })

    it('keeps database compensation authoritative when post-commit storage cleanup fails', async () => {
        mockGetFileFromUpload.mockRejectedValueOnce(new Error('file failed'))
        mockRemoveFilesFromStorage.mockRejectedValueOnce(new Error('storage cleanup failed'))
        const { promise, documentStoreRepository } = execute()

        await expect(promise).rejects.toMatchObject({ statusCode: 500, message: 'Document store upsert failed' })
        expect(documentStoreRepository.delete).toHaveBeenCalledWith({
            id: 'created-store',
            workspaceId: 'workspace-1',
            generationId: expect.any(String),
            revision: 1
        })
        expect(documentStoreRepository.update).not.toHaveBeenCalled()
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_create_compensation_cleanup_failed', {
            failedCount: 1,
            phase: 'storage'
        })
    })

    it.each([
        ['chunk', 'chunkRepository'],
        ['history', 'upsertHistoryRepository']
    ])('preserves the recovery anchor when %s compensation fails', async (_phase, repositoryName) => {
        const repositories = createDataSource(true)
        ;(repositories[repositoryName as 'chunkRepository' | 'upsertHistoryRepository'].delete as jest.Mock).mockRejectedValueOnce(
            new Error('private cleanup detail')
        )

        await expect(
            handleCreatedDocumentStoreFailure(
                repositories.dataSource,
                'org-1',
                'workspace-1',
                { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
                {} as any,
                false
            )
        ).rejects.toMatchObject({ statusCode: 500, message: 'Document store creation compensation requires recovery' })

        expect(repositories.documentStoreRepository.delete).not.toHaveBeenCalled()
        expect(repositories.documentStoreRepository.update).toHaveBeenCalledWith(
            { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
            { status: 'STALE' }
        )
        expect(repositories.chunkRepository.delete).toHaveBeenCalledWith({ storeId: 'created-store' })
        if (_phase === 'chunk') {
            expect(repositories.upsertHistoryRepository.delete).not.toHaveBeenCalled()
        } else {
            expect(repositories.upsertHistoryRepository.delete).toHaveBeenCalledWith({ chatflowid: 'created-store' })
        }
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('private cleanup detail')
    })

    it('never deletes a concurrently edited created store from a freshly reread revision', async () => {
        const repositories = createDataSource(true)
        await repositories.documentStoreRepository.update(
            { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
            { status: 'SYNC' }
        )

        await expect(
            handleCreatedDocumentStoreFailure(
                repositories.dataSource,
                'org-1',
                'workspace-1',
                { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
                {} as any,
                false
            )
        ).rejects.toMatchObject({
            statusCode: 409,
            message: 'Document store creation compensation changed concurrently'
        })

        expect(repositories.documentStoreRepository.delete).toHaveBeenCalledWith({
            id: 'created-store',
            workspaceId: 'workspace-1',
            generationId: CREATED_GENERATION_ID,
            revision: 1
        })
        expect(mockRemoveFilesFromStorage).not.toHaveBeenCalled()
    })

    it('accepts the revision advanced by this create operation as its compensation ownership proof', async () => {
        const repositories = createDataSource(true)
        await repositories.documentStoreRepository.update(
            { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
            { status: 'SYNCING' }
        )

        await expect(
            handleCreatedDocumentStoreFailure(
                repositories.dataSource,
                'org-1',
                'workspace-1',
                { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 2 },
                {} as any,
                false
            )
        ).resolves.toBeUndefined()

        expect(repositories.documentStoreRepository.delete).toHaveBeenCalledWith({
            id: 'created-store',
            workspaceId: 'workspace-1',
            generationId: CREATED_GENERATION_ID,
            revision: 2
        })
        expect(mockRemoveFilesFromStorage).toHaveBeenCalledWith('org-1', 'docustore', 'created-store')
    })

    it('rejects a delayed queued upsert identity before upload, storage, or provider side effects', async () => {
        const repositories = createDataSource(true)
        await repositories.documentStoreRepository.update(
            {
                id: 'created-store',
                workspaceId: 'workspace-1',
                generationId: CREATED_GENERATION_ID,
                revision: 1
            },
            { status: 'SYNC' }
        )

        await expect(
            executeDocStoreUpsert({
                appDataSource: repositories.dataSource,
                componentNodes: safeComponents,
                telemetry: {} as any,
                storeId: 'created-store',
                totalItems: [{ docId: 'doc-1' }],
                files: [],
                isRefreshAPI: false,
                orgId: 'org-1',
                workspaceId: 'workspace-1',
                subscriptionId: 'subscription-1',
                usageCacheManager: {} as any,
                operationIdentity: operationIdentityForCreatedStore()
            })
        ).rejects.toMatchObject({ statusCode: 409, message: 'Document store changed concurrently' })

        expect(mockGetFileFromUpload).not.toHaveBeenCalled()
        expect(mockAddArrayFilesToStorage).not.toHaveBeenCalled()
        expect(mockCheckStorage).not.toHaveBeenCalled()
    })

    it('threads one operation revision through loader, chunk, vector, and compensation stages', () => {
        const source = require('fs').readFileSync(`${__dirname}/index.ts`, 'utf8') as string
        const upsertStart = source.indexOf('const upsertDocStore')
        const upsertSource = source.slice(upsertStart, source.indexOf('export const executeDocStoreUpsert', upsertStart))
        const processLoaderCall = upsertSource.slice(
            upsertSource.indexOf('const result = await processLoader('),
            upsertSource.indexOf('const newDocId = result.docId')
        )
        const insertIntoVectorStoreCall = upsertSource.slice(
            upsertSource.indexOf('const res = await insertIntoVectorStore('),
            upsertSource.indexOf('res.docId = newDocId')
        )

        expect(upsertSource).toContain('createDocumentStoreOperationRevision(dbResponse)')
        expect(upsertSource).toContain('saveProcessingLoader(appDataSource, processData, workspaceId, operationRevision)')
        expect(processLoaderCall).toContain('operationRevision')
        expect(insertIntoVectorStoreCall).toContain('operationRevision')
        expect(upsertSource).toContain('generationId: createdDocumentStore.generationId')
        expect(upsertSource).toContain('revision: operationRevision?.revision ?? createdDocumentStore.revision')
    })

    it('sets the provider-side-effect phase before vector-store node initialization', () => {
        const source = require('fs').readFileSync(`${__dirname}/index.ts`, 'utf8') as string
        const workerStart = source.indexOf('const _insertIntoVectorStoreWorkerThread')
        const workerSource = source.slice(workerStart, source.indexOf('// Get all component nodes', workerStart))

        expect(workerSource.indexOf('onProviderUpsertAttempt?.()')).toBeGreaterThanOrEqual(0)
        expect(workerSource.indexOf('onProviderUpsertAttempt?.()')).toBeLessThan(
            workerSource.indexOf('await _createVectorStoreObject(componentNodes, data, vStoreNodeData, upsertHistory)')
        )
    })

    it('preserves and marks the scoped recovery anchor once provider side effects are possible', async () => {
        const { dataSource, documentStoreRepository, chunkRepository, upsertHistoryRepository } = createDataSource(true)

        await expect(
            handleCreatedDocumentStoreFailure(
                dataSource,
                'org-1',
                'workspace-1',
                { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
                {} as any,
                true
            )
        ).rejects.toMatchObject({ statusCode: 500, message: 'Document store vector upsert requires recovery' })

        expect(documentStoreRepository.update).toHaveBeenCalledWith(
            { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
            { status: 'STALE' }
        )
        expect(documentStoreRepository.findOneBy).not.toHaveBeenCalled()
        expect(documentStoreRepository.delete).not.toHaveBeenCalled()
        expect(chunkRepository.delete).not.toHaveBeenCalled()
        expect(upsertHistoryRepository.delete).not.toHaveBeenCalled()
        expect(mockRemoveFilesFromStorage).not.toHaveBeenCalled()
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_create_recovery_required', {
            failedCount: 1,
            phase: 'provider'
        })
    })

    it('does not let recovery take over a same-ID replacement generation', async () => {
        const repositories = createDataSource(true)
        const replacementGeneration = '44444444-4444-4444-8444-444444444444'
        ;(await repositories.documentStoreRepository.findOneBy()).generationId = replacementGeneration
        repositories.documentStoreRepository.findOneBy.mockClear()

        await expect(
            handleCreatedDocumentStoreFailure(
                repositories.dataSource,
                'org-1',
                'workspace-1',
                { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
                {} as any,
                true
            )
        ).rejects.toMatchObject({ statusCode: 409, message: 'Document store recovery state changed concurrently' })

        expect(repositories.documentStoreRepository.update).toHaveBeenCalledWith(
            { id: 'created-store', workspaceId: 'workspace-1', generationId: CREATED_GENERATION_ID, revision: 1 },
            { status: 'STALE' }
        )
        expect(repositories.documentStoreRepository.findOneBy).not.toHaveBeenCalled()
        expect(await repositories.documentStoreRepository.findOneBy()).toMatchObject({
            generationId: replacementGeneration,
            status: 'EMPTY',
            revision: 1
        })
    })

    it('rejects provider recovery with a mismatched trusted workspace before any write', async () => {
        const repositories = createDataSource(true)

        await expect(
            handleCreatedDocumentStoreFailure(
                repositories.dataSource,
                'org-1',
                'workspace-1',
                { id: 'created-store', workspaceId: 'workspace-2', generationId: CREATED_GENERATION_ID, revision: 1 },
                {} as any,
                true
            )
        ).rejects.toMatchObject({ statusCode: 409, message: 'Document store recovery state changed concurrently' })

        expect(repositories.documentStoreRepository.update).not.toHaveBeenCalled()
        expect(repositories.documentStoreRepository.delete).not.toHaveBeenCalled()
    })
})
