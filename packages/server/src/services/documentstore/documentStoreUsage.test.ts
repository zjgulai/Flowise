const mockFindBy = jest.fn()
const mockUpdate = jest.fn()
const mockGetRepository = jest.fn(() => ({ findBy: mockFindBy, update: mockUpdate }))

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
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => ({
        AppDataSource: {
            getRepository: mockGetRepository,
            transaction: (callback: (manager: { getRepository: typeof mockGetRepository }) => unknown) =>
                callback({ getRepository: mockGetRepository })
        }
    }))
}))
jest.mock('../../enterprise/utils/ControllerServiceUtils', () => ({
    getWorkspaceSearchOptions: jest.fn((workspaceId: string) => ({ workspaceId }))
}))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }))
jest.mock('../credentials', () => ({ __esModule: true, default: { assertCredentialInWorkspace: jest.fn() } }))

import documentStoreService from '.'

const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((resolver) => {
        resolve = resolver
    })
    return { promise, resolve }
}

describe('document store usage persistence', () => {
    beforeEach(() => jest.clearAllMocks())

    it('awaits every matching DocumentStore CAS before reporting completion', async () => {
        const firstSave = deferred()
        mockFindBy.mockResolvedValue([
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 1,
                whereUsed: JSON.stringify(['flow-1', 'other-flow'])
            },
            {
                id: 'store-2',
                workspaceId: 'workspace-1',
                generationId: '22222222-2222-4222-8222-222222222222',
                revision: 4,
                whereUsed: JSON.stringify(['flow-1'])
            }
        ])
        mockUpdate.mockImplementationOnce(() => firstSave.promise.then(() => ({ affected: 1 }))).mockResolvedValueOnce({ affected: 1 })

        let completed = false
        const operation = documentStoreService.updateDocumentStoreUsage('flow-1', undefined, 'workspace-1').then(() => {
            completed = true
        })
        await Promise.resolve()
        await Promise.resolve()

        expect(completed).toBe(false)
        expect(mockUpdate).toHaveBeenCalledTimes(1)
        expect(mockUpdate).toHaveBeenCalledWith(
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 1
            },
            { whereUsed: JSON.stringify(['other-flow']) }
        )

        firstSave.resolve()
        await operation

        expect(completed).toBe(true)
        expect(mockUpdate).toHaveBeenCalledTimes(2)
        expect(mockUpdate).toHaveBeenLastCalledWith(
            {
                id: 'store-2',
                workspaceId: 'workspace-1',
                generationId: '22222222-2222-4222-8222-222222222222',
                revision: 4
            },
            { whereUsed: JSON.stringify([]) }
        )
    })

    it('rejects instead of returning early when a usage CAS fails unexpectedly', async () => {
        mockFindBy.mockResolvedValue([
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 1,
                whereUsed: JSON.stringify(['flow-1'])
            }
        ])
        mockUpdate.mockRejectedValue(new Error('database unavailable'))

        await expect(documentStoreService.updateDocumentStoreUsage('flow-1', undefined, 'workspace-1')).rejects.toMatchObject({
            statusCode: 500,
            message: 'Unable to update document store usage'
        })
    })

    it('preserves a deterministic conflict when another usage writer wins', async () => {
        mockFindBy.mockResolvedValue([
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 1,
                whereUsed: JSON.stringify(['flow-1'])
            }
        ])
        mockUpdate.mockResolvedValue({ affected: 0 })

        await expect(documentStoreService.updateDocumentStoreUsage('flow-1', undefined, 'workspace-1')).rejects.toMatchObject({
            statusCode: 409,
            message: 'Document store usage changed concurrently'
        })
    })

    it('synchronizes the complete selected store set and removes duplicate usage entries', async () => {
        mockFindBy.mockResolvedValue([
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 1,
                whereUsed: JSON.stringify(['flow-1', 'flow-1', 'other-flow'])
            },
            {
                id: 'store-2',
                workspaceId: 'workspace-1',
                generationId: '22222222-2222-4222-8222-222222222222',
                revision: 2,
                whereUsed: JSON.stringify(['other-flow'])
            },
            {
                id: 'store-3',
                workspaceId: 'workspace-1',
                generationId: '33333333-3333-4333-8333-333333333333',
                revision: 3,
                whereUsed: JSON.stringify(['flow-1'])
            }
        ])
        mockUpdate.mockResolvedValue({ affected: 1 })

        await documentStoreService.updateDocumentStoreUsage('flow-1', ['store-1', 'store-2', 'store-1'], 'workspace-1')

        expect(mockUpdate).toHaveBeenCalledTimes(3)
        expect(mockUpdate.mock.calls.map(([, patch]) => patch)).toEqual([
            { whereUsed: JSON.stringify(['other-flow', 'flow-1']) },
            { whereUsed: JSON.stringify(['other-flow', 'flow-1']) },
            { whereUsed: JSON.stringify([]) }
        ])
    })

    it('rejects a missing selected store before the first usage write', async () => {
        mockFindBy.mockResolvedValue([
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 1,
                whereUsed: JSON.stringify(['flow-1'])
            }
        ])

        await expect(
            documentStoreService.updateDocumentStoreUsage('flow-1', ['store-1', 'missing-store'], 'workspace-1')
        ).rejects.toMatchObject({
            statusCode: 404,
            message: 'One or more document stores were not found in the workspace'
        })
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('rejects malformed existing usage data before the first usage write', async () => {
        mockFindBy.mockResolvedValue([
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 1,
                whereUsed: JSON.stringify(['flow-1'])
            },
            {
                id: 'store-2',
                workspaceId: 'workspace-1',
                generationId: '22222222-2222-4222-8222-222222222222',
                revision: 2,
                whereUsed: '{not-json'
            }
        ])

        await expect(documentStoreService.updateDocumentStoreUsage('flow-1', ['store-1'], 'workspace-1')).rejects.toMatchObject({
            statusCode: 409,
            message: 'Document store usage data is invalid'
        })
        expect(mockUpdate).not.toHaveBeenCalled()
    })
})
