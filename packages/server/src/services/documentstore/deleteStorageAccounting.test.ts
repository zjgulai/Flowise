import { StatusCodes } from 'http-status-codes'

const mockRemoveFilesFromStorage = jest.fn()
const mockRemoveSpecificFileFromStorage = jest.fn()
const mockGetStorageSize = jest.fn()
const mockUpdateStorageUsage = jest.fn()
const mockLoggerError = jest.fn()
const mockLoggerWarn = jest.fn()
const mockGetRunningExpressApp = jest.fn()

jest.mock('flowise-components', () => ({
    addArrayFilesToStorage: jest.fn(),
    addSingleFileToStorage: jest.fn(),
    extractResponseContent: jest.fn(),
    getFileFromStorage: jest.fn(),
    getFileFromUpload: jest.fn(),
    getStorageSize: (...args: unknown[]) => mockGetStorageSize(...args),
    mapExtToInputField: jest.fn(),
    mapMimeTypeToInputField: jest.fn(),
    removeFilesFromStorage: (...args: unknown[]) => mockRemoveFilesFromStorage(...args),
    removeSpecificFileFromStorage: (...args: unknown[]) => mockRemoveSpecificFileFromStorage(...args),
    removeSpecificFileFromUpload: jest.fn(),
    resolveSafeChatModelSelection: jest.fn()
}))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: () => mockGetRunningExpressApp() }))
jest.mock('../../utils/quotaUsage', () => ({
    checkStorage: jest.fn(),
    updateStorageUsage: (...args: unknown[]) => mockUpdateStorageUsage(...args)
}))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        error: (...args: unknown[]) => mockLoggerError(...args),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        debug: jest.fn()
    }
}))
jest.mock('../credentials', () => ({ __esModule: true, default: { assertCredentialInWorkspace: jest.fn() } }))

import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { UpsertHistory } from '../../database/entities/UpsertHistory'
import { DocumentStoreStatus } from '../../Interface'
import { createDocumentStoreOperationIdentity, createDocumentStoreVersionToken, parseDocumentStoreIfMatch } from './documentStoreVersion'
import documentStoreService from '.'

const STORE_ID = '11111111-1111-4111-8111-111111111111'
const DOC_ID = '22222222-2222-4222-8222-222222222222'
const GENERATION_ID = '33333333-3333-4333-8333-333333333333'
const operationIdentity = () =>
    createDocumentStoreOperationIdentity(
        STORE_ID,
        'workspace-1',
        parseDocumentStoreIfMatch(
            createDocumentStoreVersionToken({
                id: STORE_ID,
                workspaceId: 'workspace-1',
                generationId: GENERATION_ID,
                revision: 7
            })
        )
    )
const documentStoreRepository = {
    findOneBy: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
}
const chunkRepository = { delete: jest.fn() }
const historyRepository = { delete: jest.fn() }
const mockTransaction = jest.fn()

const getRepository = (entity: unknown) => {
    if (entity === DocumentStore) return documentStoreRepository
    if (entity === DocumentStoreFileChunk) return chunkRepository
    if (entity === UpsertHistory) return historyRepository
    throw new Error('unexpected repository')
}

const loaderStore = () =>
    ({
        id: STORE_ID,
        name: 'Synthetic store',
        description: null,
        workspaceId: 'workspace-1',
        status: DocumentStoreStatus.SYNC,
        generationId: GENERATION_ID,
        revision: 7,
        loaders: JSON.stringify([{ id: DOC_ID, files: [{ name: 'first.pdf' }, { name: 'second.pdf' }] }]),
        whereUsed: null,
        vectorStoreConfig: null,
        embeddingConfig: null,
        recordManagerConfig: null,
        createdDate: new Date('2026-08-02T18:22:15.000Z'),
        updatedDate: new Date('2026-08-02T18:22:15.000Z')
    } as unknown as DocumentStore)

describe('document store DB-first destructive cleanup boundaries', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository,
                transaction: (...args: unknown[]) => mockTransaction(...args)
            }
        })
        documentStoreRepository.findOneBy.mockResolvedValue(loaderStore())
        documentStoreRepository.save.mockImplementation(async (entity) => entity)
        documentStoreRepository.update.mockResolvedValue({ affected: 1 })
        documentStoreRepository.delete.mockResolvedValue({ affected: 1 })
        chunkRepository.delete.mockResolvedValue({ affected: 1 })
        historyRepository.delete.mockResolvedValue({ affected: 1 })
        mockTransaction.mockImplementation(async (callback) => callback({ getRepository }))
        mockRemoveFilesFromStorage.mockResolvedValue({ totalSize: 12 })
        mockRemoveSpecificFileFromStorage.mockResolvedValue({ totalSize: 6 })
        mockGetStorageSize.mockResolvedValue(12 * 1024 * 1024)
        mockUpdateStorageUsage.mockResolvedValue(undefined)
    })

    it('commits the loader chunk delete and exact revision CAS before best-effort storage accounting', async () => {
        mockUpdateStorageUsage.mockRejectedValue(new Error('RAW_LOADER_CACHE_SECRET'))

        await expect(
            documentStoreService.deleteLoaderFromDocumentStore(
                STORE_ID,
                DOC_ID,
                'organization-1',
                'workspace-1',
                {} as never,
                operationIdentity()
            )
        ).resolves.toMatchObject({ id: STORE_ID, loaders: '[]' })

        expect(chunkRepository.delete).toHaveBeenCalledWith({ storeId: STORE_ID, docId: DOC_ID })
        expect(documentStoreRepository.update).toHaveBeenCalledWith(
            { id: STORE_ID, workspaceId: 'workspace-1', generationId: GENERATION_ID, revision: 7 },
            { loaders: '[]', status: DocumentStoreStatus.STALE }
        )
        expect(documentStoreRepository.update.mock.invocationCallOrder[0]).toBeLessThan(
            mockRemoveSpecificFileFromStorage.mock.invocationCallOrder[0]
        )
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_loader_delete_storage_cleanup_failed', {
            failedCount: 2,
            phase: 'accounting'
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('RAW_LOADER_CACHE_SECRET')
    })

    it('keeps the committed loader DB deletion after a partial storage failure and logs only a fixed aggregate', async () => {
        mockRemoveSpecificFileFromStorage
            .mockResolvedValueOnce({ totalSize: 6 })
            .mockRejectedValueOnce(new Error('RAW_PARTIAL_STORAGE_SECRET'))

        await expect(
            documentStoreService.deleteLoaderFromDocumentStore(
                STORE_ID,
                DOC_ID,
                'organization-1',
                'workspace-1',
                {} as never,
                operationIdentity()
            )
        ).resolves.toMatchObject({ id: STORE_ID, loaders: '[]' })

        expect(mockTransaction).toHaveBeenCalledTimes(1)
        expect(chunkRepository.delete).toHaveBeenCalledWith({ storeId: STORE_ID, docId: DOC_ID })
        expect(documentStoreRepository.update).toHaveBeenCalledTimes(1)
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_loader_delete_storage_cleanup_failed', {
            failedCount: 1,
            phase: 'storage'
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('RAW_PARTIAL_STORAGE_SECRET')
    })

    it('does not touch loader storage when the revision CAS loses a concurrent race', async () => {
        documentStoreRepository.update.mockResolvedValueOnce({ affected: 0 })

        await expect(
            documentStoreService.deleteLoaderFromDocumentStore(
                STORE_ID,
                DOC_ID,
                'organization-1',
                'workspace-1',
                {} as never,
                operationIdentity()
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Document store loader changed concurrently' })

        expect(chunkRepository.delete).toHaveBeenCalledWith({ storeId: STORE_ID, docId: DOC_ID })
        expect(mockRemoveSpecificFileFromStorage).not.toHaveBeenCalled()
    })

    it('does not touch loader storage when its transaction rolls back before the CAS', async () => {
        chunkRepository.delete.mockRejectedValueOnce(new Error('RAW_CHUNK_DELETE_SECRET'))

        await expect(
            documentStoreService.deleteLoaderFromDocumentStore(
                STORE_ID,
                DOC_ID,
                'organization-1',
                'workspace-1',
                {} as never,
                operationIdentity()
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.INTERNAL_SERVER_ERROR, message: 'Failed to delete document store loader' })

        expect(documentStoreRepository.update).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromStorage).not.toHaveBeenCalled()
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('RAW_CHUNK_DELETE_SECRET')
    })

    it('treats missing loader blobs and derived accounting as post-commit best-effort cleanup', async () => {
        mockRemoveSpecificFileFromStorage.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        mockUpdateStorageUsage.mockRejectedValue(new Error('RAW_RECONCILE_SECRET'))

        await expect(
            documentStoreService.deleteLoaderFromDocumentStore(
                STORE_ID,
                DOC_ID,
                'organization-1',
                'workspace-1',
                {} as never,
                operationIdentity()
            )
        ).resolves.toMatchObject({ id: STORE_ID, loaders: '[]' })

        expect(mockGetStorageSize).toHaveBeenCalledTimes(2)
        expect(mockLoggerWarn).toHaveBeenCalledWith('document_store_loader_delete_storage_cleanup_failed_idempotent_missing', {
            idempotentMissingCount: 2,
            totalCount: 2
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('RAW_RECONCILE_SECRET')
    })

    it('commits full-store child deletion and an exact revision CAS before storage cleanup', async () => {
        await expect(
            documentStoreService.deleteDocumentStore(STORE_ID, 'organization-1', 'workspace-1', {} as never, operationIdentity())
        ).resolves.toEqual({
            deleted: 1
        })

        expect(chunkRepository.delete).toHaveBeenCalledWith({ storeId: STORE_ID })
        expect(historyRepository.delete).toHaveBeenCalledWith({ chatflowid: STORE_ID })
        expect(documentStoreRepository.delete).toHaveBeenCalledWith({
            id: STORE_ID,
            workspaceId: 'workspace-1',
            generationId: GENERATION_ID,
            revision: 7
        })
        expect(documentStoreRepository.delete.mock.invocationCallOrder[0]).toBeLessThan(
            mockRemoveFilesFromStorage.mock.invocationCallOrder[0]
        )
    })

    it('keeps the committed full-store DB deletion after storage failure and logs only a fixed aggregate', async () => {
        mockRemoveFilesFromStorage.mockRejectedValueOnce(new Error('RAW_FOLDER_STORAGE_SECRET'))

        await expect(
            documentStoreService.deleteDocumentStore(STORE_ID, 'organization-1', 'workspace-1', {} as never, operationIdentity())
        ).resolves.toEqual({
            deleted: 1
        })

        expect(mockTransaction).toHaveBeenCalledTimes(1)
        expect(documentStoreRepository.delete).toHaveBeenCalledTimes(1)
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_delete_storage_cleanup_failed', {
            failedCount: 1,
            phase: 'storage'
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('RAW_FOLDER_STORAGE_SECRET')
    })

    it('keeps a confirmed-missing full-store cleanup and accounting failure best effort', async () => {
        mockRemoveFilesFromStorage.mockRejectedValueOnce(Object.assign(new Error('missing'), { statusCode: StatusCodes.NOT_FOUND }))
        mockGetStorageSize.mockRejectedValueOnce(new Error('RAW_SIZE_SECRET'))

        await expect(
            documentStoreService.deleteDocumentStore(STORE_ID, 'organization-1', 'workspace-1', {} as never, operationIdentity())
        ).resolves.toEqual({
            deleted: 1
        })

        expect(mockLoggerError).toHaveBeenCalledWith('document_store_delete_storage_cleanup_failed', {
            failedCount: 1,
            phase: 'accounting'
        })
        expect(mockLoggerWarn).toHaveBeenCalledWith('document_store_delete_storage_idempotent_missing', {
            idempotentMissingCount: 1,
            totalCount: 1
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('RAW_SIZE_SECRET')
    })

    it('does not touch full-store storage when the revision CAS loses a concurrent race', async () => {
        documentStoreRepository.delete.mockResolvedValueOnce({ affected: 0 })

        await expect(
            documentStoreService.deleteDocumentStore(STORE_ID, 'organization-1', 'workspace-1', {} as never, operationIdentity())
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Document store changed concurrently' })

        expect(chunkRepository.delete).toHaveBeenCalledWith({ storeId: STORE_ID })
        expect(historyRepository.delete).toHaveBeenCalledWith({ chatflowid: STORE_ID })
        expect(mockRemoveFilesFromStorage).not.toHaveBeenCalled()
    })

    it('does not touch full-store storage when its transaction rolls back before store CAS', async () => {
        historyRepository.delete.mockRejectedValueOnce(new Error('RAW_HISTORY_DELETE_SECRET'))

        await expect(
            documentStoreService.deleteDocumentStore(STORE_ID, 'organization-1', 'workspace-1', {} as never, operationIdentity())
        ).rejects.toMatchObject({ statusCode: StatusCodes.INTERNAL_SERVER_ERROR, message: 'Failed to delete document store' })

        expect(documentStoreRepository.delete).not.toHaveBeenCalled()
        expect(mockRemoveFilesFromStorage).not.toHaveBeenCalled()
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('RAW_HISTORY_DELETE_SECRET')
    })
})
