import client from './client'

const MISSING_VERSION_TOKEN_MESSAGE = '缺少文档库版本令牌，请刷新页面后重试'
export const DOCUMENT_STORE_VERSION_CONFLICT_MESSAGE = '文档库已被其他操作更新，请确认后重试'
export const isDocumentStoreVersionConflict = (error) => error?.response?.status === 409

/**
 * Keep the server-issued strong ETag opaque. The UI must neither parse nor
 * reconstruct it, otherwise a delete/recreate cycle could reuse stale intent.
 */
export const requireDocumentStoreVersionToken = (value) => {
    const versionToken = typeof value === 'string' ? value : value?.versionToken
    if (typeof versionToken !== 'string' || !versionToken.trim()) {
        throw new Error(MISSING_VERSION_TOKEN_MESSAGE)
    }
    return versionToken
}

const withVersionToken = (versionToken) => ({
    headers: {
        'If-Match': requireDocumentStoreVersionToken(versionToken)
    }
})

const getAllDocumentStores = (params) => client.get('/document-store/store', { params })
const getDocumentLoaders = () => client.get('/document-store/components/loaders')
const getSpecificDocumentStore = (id) => client.get(`/document-store/store/${id}`)
const createDocumentStore = (body) => client.post(`/document-store/store`, body)
const updateDocumentStore = (id, body, versionToken) => client.put(`/document-store/store/${id}`, body, withVersionToken(versionToken))
const deleteDocumentStore = (id, versionToken) => client.delete(`/document-store/store/${id}`, withVersionToken(versionToken))
const getDocumentStoreConfig = (storeId, loaderId) => client.get(`/document-store/store-configs/${storeId}/${loaderId}`)

const deleteLoaderFromStore = (id, fileId, versionToken) =>
    client.delete(`/document-store/loader/${id}/${fileId}`, withVersionToken(versionToken))
const deleteChunkFromStore = (storeId, loaderId, chunkId, versionToken) =>
    client.delete(`/document-store/chunks/${storeId}/${loaderId}/${chunkId}`, withVersionToken(versionToken))
const editChunkFromStore = (storeId, loaderId, chunkId, body, versionToken) =>
    client.put(`/document-store/chunks/${storeId}/${loaderId}/${chunkId}`, body, withVersionToken(versionToken))

const getFileChunks = (storeId, fileId, pageNo) => client.get(`/document-store/chunks/${storeId}/${fileId}/${pageNo}`)
const previewChunks = (body) => client.post('/document-store/loader/preview', body)
const processLoader = (body, loaderId, versionToken) =>
    client.post(`/document-store/loader/process/${loaderId}`, body, withVersionToken(versionToken))
const saveProcessingLoader = (body, versionToken) => client.post(`/document-store/loader/save`, body, withVersionToken(versionToken))
const refreshLoader = (storeId, versionToken) => client.post(`/document-store/refresh/${storeId}`, {}, withVersionToken(versionToken))

const insertIntoVectorStore = (body, versionToken) =>
    client.post(`/document-store/vectorstore/insert`, body, withVersionToken(versionToken))
const saveVectorStoreConfig = (body, versionToken) => client.post(`/document-store/vectorstore/save`, body, withVersionToken(versionToken))
const updateVectorStoreConfig = (body, versionToken) =>
    client.post(`/document-store/vectorstore/update`, body, withVersionToken(versionToken))
const deleteVectorStoreDataFromStore = (storeId, docId, versionToken) => {
    const url = docId ? `/document-store/vectorstore/${storeId}?docId=${docId}` : `/document-store/vectorstore/${storeId}`
    return client.delete(url, withVersionToken(versionToken))
}
const queryVectorStore = (body) => client.post(`/document-store/vectorstore/query`, body)
const getVectorStoreProviders = () => client.get('/document-store/components/vectorstore')
const getEmbeddingProviders = () => client.get('/document-store/components/embeddings')
const getRecordManagerProviders = () => client.get('/document-store/components/recordmanager')

const generateDocStoreToolDesc = (storeId, body) => client.post('/document-store/generate-tool-desc/' + storeId, body)

export default {
    getAllDocumentStores,
    getSpecificDocumentStore,
    createDocumentStore,
    deleteLoaderFromStore,
    getFileChunks,
    updateDocumentStore,
    previewChunks,
    processLoader,
    getDocumentLoaders,
    deleteChunkFromStore,
    editChunkFromStore,
    deleteDocumentStore,
    insertIntoVectorStore,
    getVectorStoreProviders,
    getEmbeddingProviders,
    getRecordManagerProviders,
    saveVectorStoreConfig,
    queryVectorStore,
    deleteVectorStoreDataFromStore,
    updateVectorStoreConfig,
    saveProcessingLoader,
    refreshLoader,
    generateDocStoreToolDesc,
    getDocumentStoreConfig
}
