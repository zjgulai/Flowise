import { Request, Response } from 'express'
import { removeSpecificFileFromUpload } from 'flowise-components'
import documentStoreService from '../../services/documentstore'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { createDocumentStoreVersionToken } from '../../services/documentstore/documentStoreVersion'

jest.mock('flowise-components', () => ({ removeSpecificFileFromUpload: jest.fn() }))
jest.mock('../../services/documentstore', () => ({
    __esModule: true,
    default: { upsertDocStoreMiddleware: jest.fn(), refreshDocStoreMiddleware: jest.fn() }
}))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }))

import documentStoreController from '.'

const mockRemoveSpecificFileFromUpload = removeSpecificFileFromUpload as jest.Mock
const mockUpsertDocStoreMiddleware = documentStoreService.upsertDocStoreMiddleware as jest.Mock
const mockRefreshDocStoreMiddleware = documentStoreService.refreshDocStoreMiddleware as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const mockLoggerError = logger.error as jest.Mock
const incrementCounter = jest.fn()

const files = [
    { path: '/tmp/document-one' },
    { path: '/tmp/document-one' },
    { key: 'object-document-two' }
] as unknown as Express.Multer.File[]

const createResponse = () => ({ json: jest.fn() } as unknown as Response)

const createRequest = (overrides: Record<string, unknown> = {}) =>
    ({
        params: { id: 'store-1' },
        body: {},
        headers: {
            'if-match': createDocumentStoreVersionToken({
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '11111111-1111-4111-8111-111111111111',
                revision: 1
            })
        },
        files,
        user: {
            activeOrganizationId: 'org-1',
            activeWorkspaceId: 'workspace-1',
            permissions: ['documentStores:upsert-config']
        },
        ...overrides
    } as unknown as Request)

describe('document store upsert pre-service upload cleanup', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockRemoveSpecificFileFromUpload.mockResolvedValue(undefined)
        mockUpsertDocStoreMiddleware.mockResolvedValue({ id: 'store-1' })
        mockRefreshDocStoreMiddleware.mockResolvedValue({ id: 'store-1' })
        mockGetRunningExpressApp.mockReturnValue({ usageCacheManager: {}, metricsProvider: { incrementCounter } })
    })

    it('cleans every unique upload exactly once when the store id is missing', async () => {
        const req = createRequest({ params: {} })
        const res = createResponse()
        const next = jest.fn()

        await documentStoreController.upsertDocStoreMiddleware(req, res, next)

        expect(mockUpsertDocStoreMiddleware).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/document-one')
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('object-document-two')
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 412 })
    })

    it('cleans uploads before returning a missing-workspace error', async () => {
        const req = createRequest({
            user: { activeOrganizationId: 'org-1', permissions: ['documentStores:upsert-config'] }
        })
        const res = createResponse()
        const next = jest.fn()

        await documentStoreController.upsertDocStoreMiddleware(req, res, next)

        expect(mockUpsertDocStoreMiddleware).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 412 })
    })

    it('lets a cleanup failure override the original validation error with a fixed 500', async () => {
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('private temporary path detail'))
        const req = createRequest({ params: {} })
        const res = createResponse()
        const next = jest.fn()

        await documentStoreController.upsertDocStoreMiddleware(req, res, next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 500, message: 'Document store upload cleanup failed' })
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_rejected_upload_cleanup_failed', {
            failedCount: 1,
            totalCount: 2
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('private temporary path')
    })

    it('does not race service-owned cleanup after delegation', async () => {
        mockUpsertDocStoreMiddleware.mockRejectedValueOnce(new Error('service failed after taking upload ownership'))
        const req = createRequest()
        const res = createResponse()
        const next = jest.fn()

        await documentStoreController.upsertDocStoreMiddleware(req, res, next)

        expect(mockUpsertDocStoreMiddleware).toHaveBeenCalledTimes(1)
        expect(mockRemoveSpecificFileFromUpload).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledTimes(1)
    })

    it.each([undefined, '*', 'W/"stale"', '"first", "second"', 'ds-v1.unquoted'])(
        'fails a missing or malformed If-Match closed and cleans uploads before delegation (%s)',
        async (ifMatch) => {
            const req = createRequest({ headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } })
            const next = jest.fn()

            await documentStoreController.upsertDocStoreMiddleware(req, createResponse(), next)

            expect(mockUpsertDocStoreMiddleware).not.toHaveBeenCalled()
            expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
            expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 409 })
        }
    )

    it('allows create-new upsert with create authority and no If-Match token', async () => {
        const req = createRequest({
            headers: {},
            body: {
                createNewDocStore: true,
                docStore: {
                    id: 'attacker-id',
                    generationId: '22222222-2222-4222-8222-222222222222',
                    revision: 999,
                    versionToken: 'attacker-token',
                    name: 'New store'
                }
            },
            user: {
                activeOrganizationId: 'org-1',
                activeWorkspaceId: 'workspace-1',
                permissions: ['documentStores:upsert-config', 'documentStores:create']
            }
        })

        await documentStoreController.upsertDocStoreMiddleware(req, createResponse(), jest.fn())

        expect(mockUpsertDocStoreMiddleware).toHaveBeenCalledWith(
            'store-1',
            req.body,
            files,
            'org-1',
            'workspace-1',
            '',
            expect.anything(),
            undefined
        )
        expect(mockRemoveSpecificFileFromUpload).not.toHaveBeenCalled()
    })

    it('rejects create-new upsert without create authority and cleans uploaded files', async () => {
        const req = createRequest({ headers: {}, body: { createNewDocStore: true } })
        const next = jest.fn()

        await documentStoreController.upsertDocStoreMiddleware(req, createResponse(), next)

        expect(mockUpsertDocStoreMiddleware).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 })
    })

    it('does not reverse a successful upsert when the success metric throws', async () => {
        incrementCounter.mockImplementationOnce(() => {
            throw new Error('metrics secret')
        })
        const res = createResponse()
        const next = jest.fn()

        await documentStoreController.upsertDocStoreMiddleware(createRequest(), res, next)

        expect(res.json).toHaveBeenCalledWith({ id: 'store-1' })
        expect(next).not.toHaveBeenCalled()
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_vector_metric_failed', {
            failedCount: 1,
            totalCount: 1,
            status: 'success'
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('metrics secret')
    })

    it('preserves the original upsert failure when the failure metric throws', async () => {
        const originalError = new Error('service failure')
        mockUpsertDocStoreMiddleware.mockRejectedValueOnce(originalError)
        incrementCounter.mockImplementationOnce(() => {
            throw new Error('metrics secret')
        })
        const next = jest.fn()

        await documentStoreController.upsertDocStoreMiddleware(createRequest(), createResponse(), next)

        expect(next).toHaveBeenCalledWith(originalError)
        expect(mockLoggerError).toHaveBeenCalledWith('document_store_vector_metric_failed', {
            failedCount: 1,
            totalCount: 1,
            status: 'failure'
        })
    })

    it('does not reverse a successful refresh when the success metric throws', async () => {
        incrementCounter.mockImplementationOnce(() => {
            throw new Error('metrics secret')
        })
        const res = createResponse()
        const next = jest.fn()

        await documentStoreController.refreshDocStoreMiddleware(createRequest(), res, next)

        expect(res.json).toHaveBeenCalledWith({ id: 'store-1' })
        expect(next).not.toHaveBeenCalled()
    })

    it('preserves the original refresh failure when the failure metric throws', async () => {
        const originalError = new Error('refresh failure')
        mockRefreshDocStoreMiddleware.mockRejectedValueOnce(originalError)
        incrementCounter.mockImplementationOnce(() => {
            throw new Error('metrics secret')
        })
        const next = jest.fn()

        await documentStoreController.refreshDocStoreMiddleware(createRequest(), createResponse(), next)

        expect(next).toHaveBeenCalledWith(originalError)
    })
})
