import { StatusCodes } from 'http-status-codes'

const mockFindBy = jest.fn()
const mockFindOneBy = jest.fn()
const mockQueryBuilder = {
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn()
}
const mockRepository = {
    findBy: mockFindBy,
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder)
}
const mockDataSource = {
    getRepository: () => ({ findOneBy: mockFindOneBy })
} as any

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => mockRepository
        }
    })
}))

import documentStoreService from '.'

describe('documentStoreService missing-object status contract', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder)
        mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0])
    })

    it('applies search before pagination so totals and pages share one filtered dataset', async () => {
        await documentStoreService.getAllDocumentStores('workspace-1', 2, 10, 'Knowledge', 'name', 'asc')

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
            `(LOWER(doc_store.name) LIKE :search OR LOWER(COALESCE(doc_store.description, '')) LIKE :search)`,
            { search: '%knowledge%' }
        )
        expect(mockQueryBuilder.skip).toHaveBeenCalledWith(10)
        expect(mockQueryBuilder.take).toHaveBeenCalledWith(10)
        expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('doc_store.name', 'ASC')
        expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('doc_store.id', 'ASC')
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
