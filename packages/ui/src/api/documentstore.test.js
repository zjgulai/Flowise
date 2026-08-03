import documentStoreApi, { isDocumentStoreVersionConflict, requireDocumentStoreVersionToken } from './documentstore'
import client from './client'

jest.mock('./client', () => ({
    __esModule: true,
    default: {
        delete: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn()
    }
}))

const versionToken = '"ds-v1.opaque-token"'
const ifMatch = { headers: { 'If-Match': versionToken } }

describe('document store optimistic concurrency API contract', () => {
    beforeEach(() => jest.clearAllMocks())

    it('keeps the server-issued version token opaque', () => {
        const tokenWithSignificantWhitespace = '  "ds-v1.opaque-token"  '

        expect(requireDocumentStoreVersionToken({ versionToken: tokenWithSignificantWhitespace })).toBe(tokenWithSignificantWhitespace)
        expect(requireDocumentStoreVersionToken(versionToken)).toBe(versionToken)
    })

    it('recognizes only HTTP 409 as a document-store version conflict', () => {
        expect(isDocumentStoreVersionConflict({ response: { status: 409 } })).toBe(true)
        expect(isDocumentStoreVersionConflict({ response: { status: 412 } })).toBe(false)
        expect(isDocumentStoreVersionConflict(new Error('409'))).toBe(false)
    })

    it.each([
        ['update store', () => documentStoreApi.updateDocumentStore('store', { name: 'new' }, versionToken)],
        ['delete store', () => documentStoreApi.deleteDocumentStore('store', versionToken)],
        ['delete loader', () => documentStoreApi.deleteLoaderFromStore('store', 'loader', versionToken)],
        ['delete chunk', () => documentStoreApi.deleteChunkFromStore('store', 'loader', 'chunk', versionToken)],
        ['edit chunk', () => documentStoreApi.editChunkFromStore('store', 'loader', 'chunk', { pageContent: 'new' }, versionToken)],
        ['save loader', () => documentStoreApi.saveProcessingLoader({ storeId: 'store' }, versionToken)],
        ['process loader', () => documentStoreApi.processLoader({ storeId: 'store' }, 'loader', versionToken)],
        ['refresh store', () => documentStoreApi.refreshLoader('store', versionToken)],
        ['insert vectors', () => documentStoreApi.insertIntoVectorStore({ storeId: 'store' }, versionToken)],
        ['save vector config', () => documentStoreApi.saveVectorStoreConfig({ storeId: 'store' }, versionToken)],
        ['update vector config', () => documentStoreApi.updateVectorStoreConfig({ storeId: 'store' }, versionToken)],
        ['delete vectors', () => documentStoreApi.deleteVectorStoreDataFromStore('store', 'loader', versionToken)]
    ])('sends If-Match unchanged for %s', (_label, invoke) => {
        invoke()

        const request = [...client.put.mock.calls, ...client.post.mock.calls, ...client.delete.mock.calls][0]
        expect(request.at(-1)).toEqual(ifMatch)
        expect(request.at(-1).headers['If-Match']).toBe(versionToken)
    })

    it.each([
        ['update store', () => documentStoreApi.updateDocumentStore('store', {})],
        ['delete store', () => documentStoreApi.deleteDocumentStore('store')],
        ['delete loader', () => documentStoreApi.deleteLoaderFromStore('store', 'loader')],
        ['delete chunk', () => documentStoreApi.deleteChunkFromStore('store', 'loader', 'chunk')],
        ['edit chunk', () => documentStoreApi.editChunkFromStore('store', 'loader', 'chunk', {})],
        ['save loader', () => documentStoreApi.saveProcessingLoader({ storeId: 'store' })],
        ['process loader', () => documentStoreApi.processLoader({ storeId: 'store' }, 'loader')],
        ['refresh store', () => documentStoreApi.refreshLoader('store')],
        ['insert vectors', () => documentStoreApi.insertIntoVectorStore({ storeId: 'store' })],
        ['save vector config', () => documentStoreApi.saveVectorStoreConfig({ storeId: 'store' })],
        ['update vector config', () => documentStoreApi.updateVectorStoreConfig({ storeId: 'store' })],
        ['delete vectors', () => documentStoreApi.deleteVectorStoreDataFromStore('store', 'loader')]
    ])('fails closed before issuing %s without a version token', (_label, invoke) => {
        expect(invoke).toThrow('缺少文档库版本令牌')
        expect(client.put).not.toHaveBeenCalled()
        expect(client.post).not.toHaveBeenCalled()
        expect(client.delete).not.toHaveBeenCalled()
    })

    it('does not attach If-Match to create, read, preview, query, or description generation', () => {
        documentStoreApi.createDocumentStore({ name: 'new' })
        documentStoreApi.getSpecificDocumentStore('store')
        documentStoreApi.previewChunks({ storeId: 'store' })
        documentStoreApi.queryVectorStore({ storeId: 'store' })
        documentStoreApi.generateDocStoreToolDesc('store', {})

        expect(client.get).toHaveBeenCalledWith('/document-store/store/store')
        expect(client.post).toHaveBeenNthCalledWith(1, '/document-store/store', { name: 'new' })
        expect(client.post).toHaveBeenNthCalledWith(2, '/document-store/loader/preview', { storeId: 'store' })
        expect(client.post).toHaveBeenNthCalledWith(3, '/document-store/vectorstore/query', { storeId: 'store' })
        expect(client.post).toHaveBeenNthCalledWith(4, '/document-store/generate-tool-desc/store', {})
    })

    it('supports strict save-to-process token chaining without reusing the stale token', async () => {
        const advancedToken = '"ds-v1.advanced-token"'
        client.post.mockResolvedValueOnce({ data: { id: 'loader', versionToken: advancedToken } }).mockResolvedValueOnce({ data: {} })

        const saveResponse = await documentStoreApi.saveProcessingLoader({ storeId: 'store' }, versionToken)
        await documentStoreApi.processLoader(
            { storeId: 'store' },
            saveResponse.data.id,
            requireDocumentStoreVersionToken(saveResponse.data)
        )

        expect(client.post).toHaveBeenNthCalledWith(1, '/document-store/loader/save', { storeId: 'store' }, ifMatch)
        expect(client.post).toHaveBeenNthCalledWith(
            2,
            '/document-store/loader/process/loader',
            { storeId: 'store' },
            {
                headers: { 'If-Match': advancedToken }
            }
        )
    })

    it('returns an advanced token from an explicitly requested vector cleanup', async () => {
        const advancedToken = '"ds-v1.after-vector-delete"'
        client.delete.mockResolvedValueOnce({ data: { deleted: true, versionToken: advancedToken } })

        const vectorResponse = await documentStoreApi.deleteVectorStoreDataFromStore('store', undefined, versionToken)

        expect(client.delete).toHaveBeenNthCalledWith(1, '/document-store/vectorstore/store', ifMatch)
        expect(requireDocumentStoreVersionToken(vectorResponse.data)).toBe(advancedToken)
        expect(client.delete).toHaveBeenCalledTimes(1)
    })
})
