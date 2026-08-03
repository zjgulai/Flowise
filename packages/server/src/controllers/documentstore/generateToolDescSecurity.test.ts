import { Request, Response } from 'express'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

const mockGenerateDocStoreToolDesc = jest.fn()
const mockQueryVectorStore = jest.fn()

jest.mock('../../services/documentstore', () => ({
    __esModule: true,
    default: {
        generateDocStoreToolDesc: (...args: unknown[]) => mockGenerateDocStoreToolDesc(...args),
        queryVectorStore: (...args: unknown[]) => mockQueryVectorStore(...args)
    }
}))

jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))

import documentStoreController from '.'

describe('document store tool description controller workspace scoping', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGenerateDocStoreToolDesc.mockResolvedValue({ content: 'Generated description' })
        mockQueryVectorStore.mockResolvedValue({ docs: [] })
    })

    it('passes the active workspace to the service', async () => {
        const req = {
            params: { id: 'store-1' },
            body: { selectedChatModel: { name: 'chatModel' } },
            user: { activeWorkspaceId: 'workspace-1', permissions: ['documentStores:upsert-config'] }
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await documentStoreController.generateDocStoreToolDesc(req, res, next)

        expect(mockGenerateDocStoreToolDesc).toHaveBeenCalledWith('store-1', { name: 'chatModel' }, 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it('fails closed before service execution without an active workspace', async () => {
        const req = {
            params: { id: 'store-1' },
            body: { selectedChatModel: { name: 'chatModel' } },
            user: {}
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await documentStoreController.generateDocStoreToolDesc(req, res, next)

        expect(mockGenerateDocStoreToolDesc).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0]).toBeInstanceOf(InternalFlowiseError)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 })
    })

    it('passes the active workspace to vector store queries', async () => {
        const req = {
            body: { storeId: 'store-1', query: 'support policy' },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await documentStoreController.queryVectorStore(req, res, next)

        expect(mockQueryVectorStore).toHaveBeenCalledWith({ storeId: 'store-1', query: 'support policy' }, 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it('rejects vector store queries without an active workspace', async () => {
        const req = {
            body: { storeId: 'store-1', query: 'support policy' },
            user: {}
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await documentStoreController.queryVectorStore(req, res, next)

        expect(mockQueryVectorStore).not.toHaveBeenCalled()
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 })
    })
})
