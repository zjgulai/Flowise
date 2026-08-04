const mockAddJob = jest.fn()
const mockWaitUntilFinished = jest.fn()
const mockGetRunningExpressApp = jest.fn()
const mockAddSingleFileToStorage = jest.fn()

jest.mock('flowise-components', () => ({
    addArrayFilesToStorage: jest.fn(),
    addSingleFileToStorage: (...args: unknown[]) => mockAddSingleFileToStorage(...args),
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

import { DocumentStoreStatus, MODE } from '../../Interface'
import {
    createDocumentStoreOperationIdentity,
    createDocumentStoreVersionToken,
    createDocumentStoreVersionTokenFromClaim,
    parseDocumentStoreIfMatch
} from './documentStoreVersion'
import documentStoreService, { processLoader } from '.'

const generationId = '11111111-1111-4111-8111-111111111111'
const versionIdentity = {
    id: 'store-1',
    workspaceId: 'workspace-1',
    generationId,
    revision: 1
}
const operationIdentity = createDocumentStoreOperationIdentity(
    versionIdentity.id,
    versionIdentity.workspaceId,
    parseDocumentStoreIfMatch(createDocumentStoreVersionToken(versionIdentity))
)

const entity = (revision: number) => ({
    ...versionIdentity,
    revision,
    name: 'Store',
    description: null,
    loaders: '[]',
    whereUsed: '[]',
    status: DocumentStoreStatus.SYNC,
    vectorStoreConfig: null,
    embeddingConfig: null,
    recordManagerConfig: null
})

const componentNodes = {
    safeLoader: {
        name: 'safeLoader',
        label: 'Safe loader',
        category: 'Document Loaders',
        baseClasses: ['Document'],
        inputs: [],
        filePath: 'unused-loader'
    }
} as any

describe('document store queued operation identity', () => {
    const originalMode = process.env.MODE

    beforeEach(() => {
        jest.clearAllMocks()
        process.env.MODE = MODE.QUEUE
        mockWaitUntilFinished.mockResolvedValue({})
        mockAddJob.mockResolvedValue({ id: 'job-1', waitUntilFinished: mockWaitUntilFinished })
    })

    afterAll(() => {
        process.env.MODE = originalMode
    })

    it('serializes the server identity and labels an internal response token as accepted, never final', async () => {
        const currentEntity = entity(1)
        const currentIdentity = { ...operationIdentity }
        const repository = {
            findOneBy: jest.fn().mockResolvedValue(currentEntity),
            update: jest.fn().mockResolvedValue({ affected: 1 })
        }
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: { getRepository: () => repository },
            nodesPool: { componentNodes },
            telemetry: {},
            queueManager: {
                getQueue: () => ({ addJob: mockAddJob, getQueueEvents: () => ({}) })
            }
        })

        const response = await documentStoreService.processLoaderMiddleware(
            { storeId: 'store-1', loaderId: 'safeLoader', loaderConfig: {} },
            'loader-1',
            'org-1',
            'workspace-1',
            'subscription-1',
            {} as never,
            true,
            currentIdentity
        )

        expect(response).toEqual({
            jobId: 'job-1',
            acceptedVersionToken: createDocumentStoreVersionTokenFromClaim(currentIdentity)
        })

        expect(repository.update).toHaveBeenCalledWith(
            { id: 'store-1', workspaceId: 'workspace-1', generationId, revision: 1 },
            { status: DocumentStoreStatus.STALE }
        )
        expect(currentEntity).toMatchObject({ status: DocumentStoreStatus.STALE, revision: 2 })
        expect(currentIdentity.revision).toBe(2)
        expect(mockAddJob).toHaveBeenCalledWith(expect.objectContaining({ operationIdentity: currentIdentity }))
        expect(mockWaitUntilFinished).not.toHaveBeenCalled()
        expect(mockAddJob.mock.calls[0][0]).not.toHaveProperty('versionToken')
        expect(mockAddJob.mock.calls[0][0].operationIdentity).not.toHaveProperty('generationId')
        expect(JSON.stringify(mockAddJob.mock.calls[0][0])).not.toContain(generationId)
        expect(JSON.stringify(mockAddJob.mock.calls[0][0])).not.toContain('onProviderUpsertAttempt')
    })

    it('rejects a delayed worker after the parent advances before any loader or storage work', async () => {
        const repository = { findOneBy: jest.fn().mockResolvedValue(entity(2)) }

        await expect(
            processLoader({
                appDataSource: { getRepository: () => repository } as any,
                componentNodes,
                data: { storeId: 'store-1', loaderId: 'safeLoader', loaderConfig: {} },
                docLoaderId: 'loader-1',
                isProcessWithoutUpsert: true,
                telemetry: {} as any,
                orgId: 'org-1',
                workspaceId: 'workspace-1',
                subscriptionId: 'subscription-1',
                usageCacheManager: {} as never,
                operationIdentity: { ...operationIdentity }
            })
        ).rejects.toMatchObject({ statusCode: 409, message: 'Document store loader changed concurrently' })

        expect(mockAddSingleFileToStorage).not.toHaveBeenCalled()
    })
})
