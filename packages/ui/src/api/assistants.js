import client from './client'

const pathSegment = (value) => encodeURIComponent(String(value))
const queryString = (params) => new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString()

// OpenAI Assistant
const getAssistantObj = (id, credentialId, config = {}) =>
    client.get(`/openai-assistants/${pathSegment(id)}?${queryString({ credential: credentialId })}`, config)

const getAllAvailableAssistants = (credentialId) => client.get(`/openai-assistants?${queryString({ credential: credentialId })}`)

// Assistant
const createNewAssistant = (body, config = {}) => client.post(`/assistants`, body, config)

const getAllAssistants = (type, config = {}) => client.get(`/assistants?${queryString({ type })}`, config)

const getSpecificAssistant = (id, config = {}) => client.get(`/assistants/${pathSegment(id)}`, config)

const getCustomAssistantFlow = (id, config = {}) => client.get(`/assistants/${pathSegment(id)}/custom-flow`, config)

const updateAssistant = (id, body, config = {}) => client.put(`/assistants/${pathSegment(id)}`, body, config)

const saveCustomAssistant = (id, body, config = {}) => client.put(`/assistants/${pathSegment(id)}/custom-save`, body, config)

const deleteCustomAssistant = (id, body, config = {}) => client.post(`/assistants/${pathSegment(id)}/custom-delete`, body, config)

const deleteAssistant = (id, isDeleteBoth, config = {}) =>
    isDeleteBoth
        ? client.delete(`/assistants/${pathSegment(id)}?${queryString({ isDeleteBoth: true })}`, config)
        : client.delete(`/assistants/${pathSegment(id)}`, config)

// Vector Store
const getAssistantVectorStore = (id, credentialId, config = {}) =>
    client.get(`/openai-assistants-vector-store/${pathSegment(id)}?${queryString({ credential: credentialId })}`, config)

const listAssistantVectorStore = (credentialId, config = {}) =>
    client.get(`/openai-assistants-vector-store?${queryString({ credential: credentialId })}`, config)

const createAssistantVectorStore = (credentialId, body, config = {}) =>
    client.post(`/openai-assistants-vector-store?${queryString({ credential: credentialId })}`, body, config)

const updateAssistantVectorStore = (id, credentialId, body, config = {}) =>
    client.put(`/openai-assistants-vector-store/${pathSegment(id)}?${queryString({ credential: credentialId })}`, body, config)

const deleteAssistantVectorStore = (id, credentialId, config = {}) =>
    client.delete(`/openai-assistants-vector-store/${pathSegment(id)}?${queryString({ credential: credentialId })}`, config)

// Vector Store Files
const uploadFilesToAssistantVectorStore = (id, credentialId, formData, config = {}) =>
    client.post(`/openai-assistants-vector-store/${pathSegment(id)}?${queryString({ credential: credentialId })}`, formData, {
        ...config,
        headers: { ...config.headers, 'Content-Type': 'multipart/form-data' }
    })

const deleteFilesFromAssistantVectorStore = (id, credentialId, body, config = {}) =>
    client.patch(`/openai-assistants-vector-store/${pathSegment(id)}?${queryString({ credential: credentialId })}`, body, config)

// Files
const uploadFilesToAssistant = (credentialId, formData, config = {}) =>
    client.post(`/openai-assistants-file/upload?${queryString({ credential: credentialId })}`, formData, {
        ...config,
        headers: { ...config.headers, 'Content-Type': 'multipart/form-data' }
    })

const getChatModels = () => client.get('/assistants/components/chatmodels')
const getDocStores = () => client.get('/assistants/components/docstores')
const getTools = () => client.get('/assistants/components/tools')

const generateAssistantInstruction = (body) => client.post(`/assistants/generate/instruction`, body)

export default {
    getAllAssistants,
    getSpecificAssistant,
    getCustomAssistantFlow,
    getAssistantObj,
    getAllAvailableAssistants,
    createNewAssistant,
    updateAssistant,
    saveCustomAssistant,
    deleteCustomAssistant,
    deleteAssistant,
    getAssistantVectorStore,
    listAssistantVectorStore,
    updateAssistantVectorStore,
    createAssistantVectorStore,
    uploadFilesToAssistant,
    uploadFilesToAssistantVectorStore,
    deleteFilesFromAssistantVectorStore,
    deleteAssistantVectorStore,
    getChatModels,
    getDocStores,
    getTools,
    generateAssistantInstruction
}
