export const CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION = '你是一名乐于助人的助手。'

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

export const deriveCustomAssistantToolNodeId = (toolName, index) => `${toolName}_${index}`

export const deriveDocumentStoreRetrieverToolName = (label, storeId, index) => {
    const labelName =
        typeof label === 'string'
            ? label
                  .toLowerCase()
                  .replace(/\s+/g, '_')
                  .replace(/[^a-z0-9_-]/g, '')
                  .slice(0, 64)
            : ''
    if (labelName && /[a-z0-9]/.test(labelName)) return labelName

    const storeSuffix =
        typeof storeId === 'string'
            ? storeId
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]/g, '')
                  .slice(0, 40)
            : ''
    return `document_store_${storeSuffix || index + 1}`
}

export const isExpectedCustomAssistantResource = (expectedAssistantId, candidateAssistant) =>
    isNonEmptyString(expectedAssistantId) &&
    candidateAssistant?.id === expectedAssistantId &&
    candidateAssistant?.type === 'CUSTOM' &&
    typeof candidateAssistant.details === 'string'

export const isCustomAssistantBackingFlowReady = (expectedFlowId, candidateChatflow) =>
    isNonEmptyString(expectedFlowId) && candidateChatflow?.id === expectedFlowId && candidateChatflow?.type === 'ASSISTANT'

const normalizeComponent = (component, fieldName) => {
    if (!isRecord(component) || !isNonEmptyString(component.name)) {
        throw new Error(`${fieldName} must be a component object with a name`)
    }
    if (component.inputs !== undefined && !isRecord(component.inputs)) {
        throw new Error(`${fieldName}.inputs must be an object`)
    }
    if (component.inputParams !== undefined && !Array.isArray(component.inputParams)) {
        throw new Error(`${fieldName}.inputParams must be an array`)
    }
    if (
        component.inputParams?.some(
            (inputParam) =>
                !isRecord(inputParam) ||
                !isNonEmptyString(inputParam.name) ||
                (inputParam.options !== undefined &&
                    (!Array.isArray(inputParam.options) ||
                        inputParam.options.some((option) => typeof option !== 'string' && !isRecord(option))))
        )
    ) {
        throw new Error(`${fieldName}.inputParams entries must use the expected shape`)
    }

    return {
        ...component,
        name: component.name.trim(),
        inputs: component.inputs ?? {},
        inputParams: component.inputParams ?? []
    }
}

const normalizeDocumentStore = (documentStore) => {
    if (!isRecord(documentStore) || !isNonEmptyString(documentStore.id)) {
        throw new Error('documentStores entries must include an id')
    }
    if (documentStore.name !== undefined && typeof documentStore.name !== 'string') {
        throw new Error('documentStores entries must use a string name')
    }
    if (documentStore.description !== undefined && typeof documentStore.description !== 'string') {
        throw new Error('documentStores entries must use a string description')
    }
    if (documentStore.returnSourceDocuments !== undefined && typeof documentStore.returnSourceDocuments !== 'boolean') {
        throw new Error('documentStores entries must use a boolean returnSourceDocuments value')
    }

    return {
        ...documentStore,
        id: documentStore.id.trim(),
        name: documentStore.name ?? '',
        description: documentStore.description ?? '',
        returnSourceDocuments: documentStore.returnSourceDocuments ?? false
    }
}

export const parseCustomAssistantDetails = (serializedDetails) => {
    const parsedDetails = JSON.parse(serializedDetails)
    if (!isRecord(parsedDetails) || !isNonEmptyString(parsedDetails.name)) {
        throw new Error('assistant details must be an object with a name')
    }
    if (parsedDetails.instruction !== undefined && typeof parsedDetails.instruction !== 'string') {
        throw new Error('instruction must be a string')
    }
    if (parsedDetails.flowId !== undefined && parsedDetails.flowId !== null && !isNonEmptyString(parsedDetails.flowId)) {
        throw new Error('flowId must be a non-empty string')
    }
    if (parsedDetails.documentStores !== undefined && !Array.isArray(parsedDetails.documentStores)) {
        throw new Error('documentStores must be an array')
    }
    if (parsedDetails.tools !== undefined && !Array.isArray(parsedDetails.tools)) {
        throw new Error('tools must be an array')
    }

    const chatModel =
        parsedDetails.chatModel === undefined || parsedDetails.chatModel === null
            ? {}
            : normalizeComponent(parsedDetails.chatModel, 'chatModel')
    const documentStores = (parsedDetails.documentStores ?? []).map(normalizeDocumentStore)
    const tools = (parsedDetails.tools ?? []).map((tool) => normalizeComponent(tool, 'tools entry'))

    return {
        ...parsedDetails,
        name: parsedDetails.name.trim(),
        chatModel,
        instruction: parsedDetails.instruction ?? CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION,
        flowId: parsedDetails.flowId?.trim() || undefined,
        documentStores,
        tools
    }
}

export const validateCustomAssistantSaveResponse = (responseData, { assistantId, expectedFlowData }) => {
    const assistant = responseData?.assistant
    const chatflow = responseData?.chatflow
    if (
        !isRecord(assistant) ||
        assistant.id !== assistantId ||
        assistant.type !== 'CUSTOM' ||
        typeof assistant.details !== 'string' ||
        !isNonEmptyString(assistant.updatedDate) ||
        Number.isNaN(Date.parse(assistant.updatedDate)) ||
        !isRecord(chatflow) ||
        chatflow.type !== 'ASSISTANT' ||
        !isNonEmptyString(chatflow.id) ||
        !isNonEmptyString(chatflow.name) ||
        typeof chatflow.flowData !== 'string' ||
        chatflow.flowData !== expectedFlowData ||
        !isNonEmptyString(chatflow.updatedDate) ||
        Number.isNaN(Date.parse(chatflow.updatedDate))
    ) {
        throw new Error('invalid custom assistant save response')
    }

    const details = parseCustomAssistantDetails(assistant.details)
    if (details.flowId !== chatflow.id || details.name !== chatflow.name) {
        throw new Error('inconsistent custom assistant save response')
    }

    return { assistant, chatflow, details }
}
