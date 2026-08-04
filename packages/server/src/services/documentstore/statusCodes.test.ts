import { StatusCodes } from 'http-status-codes'

const mockFindBy = jest.fn()
const mockFindOneBy = jest.fn()
const mockCreate = jest.fn()
const mockSave = jest.fn()
const mockTelemetry = jest.fn()
const mockLoggerError = jest.fn()
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
    findOneBy: mockFindOneBy,
    create: mockCreate,
    save: mockSave,
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder)
}
const mockDataSource = {
    getRepository: () => ({ findOneBy: mockFindOneBy })
} as any

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => mockRepository
        },
        telemetry: { sendTelemetry: (...args: unknown[]) => mockTelemetry(...args) },
        nodesPool: {
            componentNodes: {
                chatModel: {
                    name: 'chatModel',
                    category: 'Chat Models',
                    baseClasses: ['BaseChatModel'],
                    inputs: [],
                    filePath: 'unused-chat-model'
                }
            }
        }
    })
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { error: (...args: unknown[]) => mockLoggerError(...args), warn: jest.fn(), debug: jest.fn() }
}))

import documentStoreService from '.'

describe('documentStoreService missing-object status contract', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder)
        mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0])
        mockCreate.mockImplementation((value) => value)
        mockSave.mockImplementation(async (value) => ({ ...value, id: 'store-1' }))
        mockTelemetry.mockResolvedValue(undefined)
    })

    it('does not reverse a persisted document store when telemetry fails', async () => {
        mockTelemetry.mockRejectedValueOnce(new Error('telemetry secret'))

        await expect(
            documentStoreService.createDocumentStore(
                {
                    id: 'attacker-id',
                    name: 'Created',
                    workspaceId: 'workspace-1',
                    generationId: '99999999-9999-4999-8999-999999999999',
                    revision: 999,
                    versionToken: 'attacker-token'
                } as any,
                'organization-1'
            )
        ).resolves.toMatchObject({ id: 'store-1', name: 'Created', workspaceId: 'workspace-1' })

        expect(mockSave).toHaveBeenCalledTimes(1)
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Created',
                workspaceId: 'workspace-1',
                generationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
            })
        )
        expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('id')
        expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('revision')
        expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('versionToken')
        expect(mockCreate.mock.calls[0][0].generationId).not.toBe('99999999-9999-4999-8999-999999999999')
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_create_observability_failed', {
            failedCount: 1,
            totalCount: 1
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('telemetry secret')
    })

    it('returns a fixed error when document store persistence fails', async () => {
        mockSave.mockRejectedValueOnce(new Error('database secret'))

        await expect(
            documentStoreService.createDocumentStore({ name: 'Created', workspaceId: 'workspace-1' } as any, 'organization-1')
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to create document store'
        })
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
        mockFindOneBy.mockResolvedValue({ id: 'missing-store', workspaceId: 'workspace-1' })
        mockFindBy.mockResolvedValue([])

        await expect(
            documentStoreService.generateDocStoreToolDesc('missing-store', { name: 'chatModel', inputs: {} }, 'workspace-1')
        ).rejects.toMatchObject({ statusCode: StatusCodes.NOT_FOUND })
    })

    it('wraps an unexpected repository failure as INTERNAL_SERVER_ERROR', async () => {
        mockFindOneBy.mockResolvedValue({ id: 'store-1', workspaceId: 'workspace-1' })
        mockFindBy.mockRejectedValue(new Error('database unavailable'))

        await expect(
            documentStoreService.generateDocStoreToolDesc('store-1', { name: 'chatModel', inputs: {} }, 'workspace-1')
        ).rejects.toMatchObject({ statusCode: StatusCodes.INTERNAL_SERVER_ERROR })
    })
})
