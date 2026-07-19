import { StatusCodes } from 'http-status-codes'

const mockFindBy = jest.fn()
const mockFindOneBy = jest.fn()
const mockDataSource = {
    getRepository: () => ({ findOneBy: mockFindOneBy })
} as any

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => ({ findBy: mockFindBy })
        }
    })
}))

import documentStoreService from '.'

describe('documentStoreService missing-object status contract', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('preserves NOT_FOUND for a missing document store chunks route', async () => {
        mockFindOneBy.mockResolvedValue(null)

        await expect(
            documentStoreService.getDocumentStoreFileChunks(mockDataSource, 'missing-store', 'missing-file', 'workspace-1', 1)
        ).rejects.toMatchObject({ statusCode: StatusCodes.NOT_FOUND })
    })

    it('wraps an unexpected chunks repository failure as INTERNAL_SERVER_ERROR', async () => {
        mockFindOneBy.mockRejectedValue(new Error('database unavailable'))

        await expect(
            documentStoreService.getDocumentStoreFileChunks(mockDataSource, 'store-1', 'file-1', 'workspace-1', 1)
        ).rejects.toMatchObject({ statusCode: StatusCodes.INTERNAL_SERVER_ERROR })
    })

    it('preserves NOT_FOUND when a document store has no chunks', async () => {
        mockFindBy.mockResolvedValue([])

        await expect(documentStoreService.generateDocStoreToolDesc('missing-store', {})).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND
        })
    })

    it('wraps an unexpected repository failure as INTERNAL_SERVER_ERROR', async () => {
        mockFindBy.mockRejectedValue(new Error('database unavailable'))

        await expect(documentStoreService.generateDocStoreToolDesc('store-1', {})).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR
        })
    })
})
