import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import type { IComponentNodes } from '../../Interface'
import {
    canonicalizeSameOriginFlowReferencesForExport,
    canonicalizeSameOriginFlowReferencesInComponentListForExport,
    transformComponentListInputsForImport,
    transformFlowComponentInputsForImport
} from './flowReferenceImport'
import type { WorkspaceImportData } from './workspaceImportSecurity'

type JsonRecord = Record<string, unknown>
type DocumentStoreComponentCategory = 'Document Loaders' | 'Text Splitters' | 'Embeddings' | 'Vector Stores' | 'Record Manager'

const MAX_SANITIZE_DEPTH = 32
const MAX_SANITIZE_NODES = 50_000
const CREDENTIAL_REFERENCE_KEYS = new Set(['flowise_credential_id', 'credential', 'credentialid'])
const SENSITIVE_INPUT_TYPES = new Set(['password', 'file', 'folder', 'credential'])
const WORKSPACE_REBIND_POLICY = 'rebind'
const SENSITIVE_HEADER_INPUT_NAMES = new Set([
    'headers',
    'requestheaders',
    'requestsdeleteheaders',
    'requestsgetheaders',
    'requestspostheaders',
    'requestsputheaders'
])
const SENSITIVE_LITERAL_KEY_SUFFIXES = [
    'apikey',
    'token',
    'accesstoken',
    'refreshtoken',
    'authtoken',
    'clientsecret',
    'privatekey',
    'password',
    'passwd',
    'secret',
    'credentialid',
    'credential',
    'authorization',
    'cookie',
    'setcookie',
    'baseoptions'
] as const
const DOCUMENT_STORE_COMPONENT_BASE_CLASSES: Readonly<Record<DocumentStoreComponentCategory, readonly string[]>> = {
    'Document Loaders': ['Document'],
    'Text Splitters': ['TextSplitter'],
    Embeddings: ['Embeddings'],
    'Vector Stores': ['VectorStoreRetriever', 'BaseRetriever'],
    'Record Manager': ['RecordManager']
}
const DOCUMENT_STORE_DENIED_LOADERS = new Set(['documentStore', 'vectorStoreToDocument', 'unstructuredFolderLoader', 'folderFiles'])
const DOCUMENT_STORE_DENIED_VECTOR_STORES = new Set(['documentStoreVS', 'memoryVectorStore'])

const invalidWorkspaceExport = (): never => {
    throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, 'Workspace export contains unsupported data')
}

const isPlainRecord = (value: unknown): value is JsonRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const requirePlainRecord = (value: unknown): JsonRecord => (isPlainRecord(value) ? value : invalidWorkspaceExport())

const requireString = (value: unknown): string => (typeof value === 'string' ? value : invalidWorkspaceExport())

const requireArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : invalidWorkspaceExport())

const isCredentialReferenceKey = (key: string): boolean => CREDENTIAL_REFERENCE_KEYS.has(key.trim().toLowerCase())

const isHeaderInputName = (name: string): boolean => SENSITIVE_HEADER_INPUT_NAMES.has(name.trim().toLowerCase())

const isSensitiveLiteralKey = (key: string): boolean => {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    return SENSITIVE_LITERAL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

type TrustedInputDescriptor = {
    type: string
    workspaceExportPolicy?: string
}

const collectTrustedInputDescriptors = (
    value: unknown,
    result = new Map<string, TrustedInputDescriptor>(),
    depth = 0
): Map<string, TrustedInputDescriptor> => {
    if (depth > 8 || !Array.isArray(value)) return result
    for (const input of value) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) continue
        const parameter = input as Record<string, unknown>
        if (typeof parameter.name === 'string' && typeof parameter.type === 'string') {
            result.set(parameter.name, {
                type: parameter.type.toLowerCase(),
                workspaceExportPolicy: typeof parameter.workspaceExportPolicy === 'string' ? parameter.workspaceExportPolicy : undefined
            })
        }
        collectTrustedInputDescriptors(parameter.tabs, result, depth + 1)
        collectTrustedInputDescriptors(parameter.array, result, depth + 1)
    }
    return result
}

const sanitizeStructuredInput = (value: unknown): unknown => {
    if (value === undefined || value === null || value === '') return value
    if (typeof value === 'string') {
        let parsed: unknown
        try {
            parsed = JSON.parse(value)
        } catch {
            return invalidWorkspaceExport()
        }
        return JSON.stringify(scrubCredentialReferences(parsed))
    }
    if (!isPlainRecord(value) && !Array.isArray(value)) invalidWorkspaceExport()
    return scrubCredentialReferences(value)
}

const scrubCredentialReferences = (value: unknown, depth = 0, budget = { nodes: 0 }): unknown => {
    budget.nodes += 1
    if (budget.nodes > MAX_SANITIZE_NODES || depth > MAX_SANITIZE_DEPTH) invalidWorkspaceExport()
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((entry) => scrubCredentialReferences(entry, depth + 1, budget))
    if (!isPlainRecord(value)) invalidWorkspaceExport()
    const result: JsonRecord = {}
    for (const [key, nested] of Object.entries(value)) {
        if (isCredentialReferenceKey(key) || isHeaderInputName(key) || isSensitiveLiteralKey(key)) continue
        result[key] = scrubCredentialReferences(nested, depth + 1, budget)
    }
    return result
}

const sanitizeComponent = (value: unknown, componentNodes: IComponentNodes): JsonRecord => {
    const source = requirePlainRecord(value)
    const component = scrubCredentialReferences(source) as JsonRecord
    const componentName = typeof source.name === 'string' ? source.name : invalidWorkspaceExport()
    if (!Object.prototype.hasOwnProperty.call(componentNodes, componentName)) invalidWorkspaceExport()
    const trustedComponent = componentNodes[componentName] ?? invalidWorkspaceExport()
    const trustedInputDescriptors = collectTrustedInputDescriptors(trustedComponent.inputs)
    if (source.inputs !== undefined && !isPlainRecord(source.inputs)) invalidWorkspaceExport()
    const inputs = isPlainRecord(source.inputs) ? source.inputs : {}
    const sanitizedInputs: JsonRecord = {}
    for (const [key, nested] of Object.entries(inputs)) {
        const trustedInput = trustedInputDescriptors.get(key)
        const trustedType = trustedInput?.type
        if (
            (trustedType !== undefined && SENSITIVE_INPUT_TYPES.has(trustedType)) ||
            trustedInput?.workspaceExportPolicy === WORKSPACE_REBIND_POLICY ||
            isCredentialReferenceKey(key) ||
            isHeaderInputName(key) ||
            isSensitiveLiteralKey(key)
        ) {
            continue
        }
        const normalizedComponentName = componentName.toLowerCase()
        if (normalizedComponentName === 'custommcp' && (key === 'mcpServerConfig' || key === 'mcpActions')) continue
        if (normalizedComponentName === 'custommcpservertool' && (key === 'mcpServerId' || key === 'mcpActions')) continue
        sanitizedInputs[key] = trustedType === 'json' ? sanitizeStructuredInput(nested) : scrubCredentialReferences(nested)
    }
    component.inputs = sanitizedInputs
    return component
}

export const sanitizeFlowDataForWorkspaceExport = (flowData: unknown, componentNodes: IComponentNodes, canonicalOrigin: string): string => {
    const sanitizedFlowData = transformFlowComponentInputsForImport(requireString(flowData), (component) => {
        const sanitized = sanitizeComponent({ name: component.name, inputs: component.inputs }, componentNodes)
        return requirePlainRecord(sanitized.inputs)
    })
    const serializedFlowData = canonicalizeSameOriginFlowReferencesForExport(sanitizedFlowData, canonicalOrigin)
    let parsed: unknown
    try {
        parsed = JSON.parse(serializedFlowData)
    } catch {
        return invalidWorkspaceExport()
    }
    const parsedRecord = requirePlainRecord(parsed)
    const nodes = requireArray(parsedRecord.nodes)
    const sanitized = scrubCredentialReferences(parsedRecord) as JsonRecord
    sanitized.nodes = nodes.map((node) => {
        const nodeRecord = requirePlainRecord(node)
        const sanitizedNode = scrubCredentialReferences(nodeRecord) as JsonRecord
        sanitizedNode.data = sanitizeComponent(nodeRecord.data, componentNodes)
        sanitizedNode.selected = false
        return sanitizedNode
    })
    if (sanitized.edges === undefined) sanitized.edges = []
    if (!Array.isArray(sanitized.edges)) invalidWorkspaceExport()
    return JSON.stringify(sanitized)
}

const sanitizeTemplateFlowData = (template: JsonRecord, componentNodes: IComponentNodes, canonicalOrigin: string): string => {
    const flowData = template.flowData
    if ((flowData === undefined || flowData === null) && template.type === 'Tool') {
        return JSON.stringify(
            scrubCredentialReferences({
                iconSrc: template.iconSrc,
                schema: template.schema,
                func: template.func
            })
        )
    }
    const serializedFlowData = requireString(flowData)
    let parsed: unknown
    try {
        parsed = JSON.parse(serializedFlowData)
    } catch {
        return invalidWorkspaceExport()
    }
    if (isPlainRecord(parsed) && Array.isArray(parsed.nodes)) {
        return sanitizeFlowDataForWorkspaceExport(flowData, componentNodes, canonicalOrigin)
    }
    return JSON.stringify(scrubCredentialReferences(parsed))
}

const sanitizeAssistantDetails = (details: unknown, componentNodes: IComponentNodes, canonicalOrigin: string): string => {
    const serializedDetails = requireString(details)
    let parsed: unknown
    try {
        parsed = JSON.parse(serializedDetails)
    } catch {
        return invalidWorkspaceExport()
    }
    const parsedRecord = requirePlainRecord(parsed)
    const sanitized = scrubCredentialReferences(parsedRecord) as JsonRecord
    if (parsedRecord.chatModel !== undefined && parsedRecord.chatModel !== null) {
        sanitized.chatModel = sanitizeComponent(parsedRecord.chatModel, componentNodes)
    }
    if (parsedRecord.tools !== undefined) {
        const scrubbedToolWrappers = requireArray(parsedRecord.tools).map((tool) => scrubCredentialReferences(requirePlainRecord(tool)))
        const sanitizedTools = transformComponentListInputsForImport(scrubbedToolWrappers, (component) => {
            const sanitizedComponent = sanitizeComponent({ name: component.name, inputs: component.inputs }, componentNodes)
            return requirePlainRecord(sanitizedComponent.inputs)
        })
        sanitized.tools = canonicalizeSameOriginFlowReferencesInComponentListForExport(sanitizedTools, canonicalOrigin)
    }
    return JSON.stringify(sanitized)
}

const sanitizeJsonConfig = (value: unknown): unknown => {
    if (value === undefined || value === null || value === '') return value
    const serializedValue = requireString(value)
    let parsed: unknown
    try {
        parsed = JSON.parse(serializedValue)
    } catch {
        return invalidWorkspaceExport()
    }
    return JSON.stringify(scrubCredentialReferences(parsed))
}

const parseConfigRecord = (value: unknown): JsonRecord => {
    if (typeof value !== 'string') return requirePlainRecord(value)
    let parsed: unknown
    try {
        parsed = JSON.parse(value)
    } catch {
        return invalidWorkspaceExport()
    }
    return requirePlainRecord(parsed)
}

const isDisallowedDocumentStoreComponent = (
    component: { tags?: unknown },
    name: string,
    category: DocumentStoreComponentCategory
): boolean => {
    if (category === 'Document Loaders') return DOCUMENT_STORE_DENIED_LOADERS.has(name)
    if (category === 'Vector Stores' && DOCUMENT_STORE_DENIED_VECTOR_STORES.has(name)) return true
    return (
        (category === 'Embeddings' || category === 'Vector Stores' || category === 'Record Manager') &&
        Array.isArray(component.tags) &&
        component.tags.includes('LlamaIndex')
    )
}

const assertDocumentStoreComponentBoundary = (
    name: string,
    config: JsonRecord,
    componentNodes: IComponentNodes,
    category: DocumentStoreComponentCategory
): void => {
    if (!Object.prototype.hasOwnProperty.call(componentNodes, name)) invalidWorkspaceExport()
    const component = componentNodes[name]
    if (
        !component ||
        component.name !== name ||
        component.category !== category ||
        !Array.isArray(component.baseClasses) ||
        !DOCUMENT_STORE_COMPONENT_BASE_CLASSES[category].some((baseClass) => component.baseClasses.includes(baseClass)) ||
        typeof component.filePath !== 'string' ||
        !component.filePath ||
        !Array.isArray(component.inputs) ||
        isDisallowedDocumentStoreComponent(component, name, category)
    ) {
        invalidWorkspaceExport()
    }
    const componentInputs = Array.isArray(component.inputs) ? component.inputs : invalidWorkspaceExport()
    const allowedInputs = new Set(componentInputs.map((input) => input?.name).filter((inputName): inputName is string => !!inputName))
    if (component.credential && typeof component.credential === 'object' && typeof component.credential.name === 'string') {
        allowedInputs.add(component.credential.name)
    }
    allowedInputs.add('FLOWISE_CREDENTIAL_ID')
    if (category === 'Vector Stores') {
        for (const key of ['topK', 'searchType', 'fetchK', 'lambda']) allowedInputs.add(key)
    }
    if (Object.keys(config).some((key) => key === 'customFunction' || !allowedInputs.has(key))) invalidWorkspaceExport()
}

const sanitizeComponentConfig = (
    name: unknown,
    config: unknown,
    componentNodes: IComponentNodes,
    category: DocumentStoreComponentCategory
): JsonRecord => {
    const componentName = requireString(name)
    const componentConfig = parseConfigRecord(config)
    assertDocumentStoreComponentBoundary(componentName, componentConfig, componentNodes, category)
    const component = sanitizeComponent({ name: componentName, inputs: componentConfig }, componentNodes)
    return requirePlainRecord(component.inputs)
}

const sanitizeDocumentStoreLoaders = (value: unknown, componentNodes: IComponentNodes): string => {
    const serializedValue = requireString(value)
    let parsed: unknown
    try {
        parsed = JSON.parse(serializedValue)
    } catch {
        return invalidWorkspaceExport()
    }
    const loaders = requireArray(parsed).map((entry) => {
        const source = requirePlainRecord(entry)
        const sanitized = scrubCredentialReferences(source) as JsonRecord
        sanitized.loaderId = requireString(source.loaderId)
        sanitized.loaderConfig = sanitizeComponentConfig(source.loaderId, source.loaderConfig, componentNodes, 'Document Loaders')
        if (source.splitterId !== undefined && source.splitterId !== null && source.splitterId !== '') {
            sanitized.splitterId = requireString(source.splitterId)
            sanitized.splitterConfig = sanitizeComponentConfig(source.splitterId, source.splitterConfig, componentNodes, 'Text Splitters')
        } else {
            Reflect.deleteProperty(sanitized, 'splitterConfig')
        }
        return sanitized
    })
    return JSON.stringify(loaders)
}

const sanitizePersistedDocumentStoreComponent = (
    value: unknown,
    componentNodes: IComponentNodes,
    category: DocumentStoreComponentCategory
): unknown => {
    if (value === undefined || value === null || value === '') return value
    const serializedValue = requireString(value)
    let parsed: unknown
    try {
        parsed = JSON.parse(serializedValue)
    } catch {
        return invalidWorkspaceExport()
    }
    const source = requirePlainRecord(parsed)
    return JSON.stringify({
        name: requireString(source.name),
        config: sanitizeComponentConfig(source.name, source.config, componentNodes, category)
    })
}

const mapRecords = (value: unknown, mapper: (record: JsonRecord) => JsonRecord): JsonRecord[] => {
    return requireArray(value).map((entry) => mapper(requirePlainRecord(entry)))
}

export const sanitizeWorkspaceExportWireData = (
    value: unknown,
    componentNodes: IComponentNodes,
    canonicalOrigin: string
): WorkspaceImportData => {
    if (!componentNodes || typeof componentNodes !== 'object') invalidWorkspaceExport()
    let wireValue: unknown
    try {
        const serialized = JSON.stringify(value)
        if (!serialized) invalidWorkspaceExport()
        wireValue = JSON.parse(serialized)
    } catch {
        return invalidWorkspaceExport()
    }
    if (!isPlainRecord(wireValue)) invalidWorkspaceExport()
    const sanitized = scrubCredentialReferences(wireValue) as JsonRecord
    for (const collectionName of ['AgentFlow', 'AgentFlowV2', 'AssistantFlow', 'ChatFlow'] as const) {
        sanitized[collectionName] = mapRecords(sanitized[collectionName], (flow) => {
            const sanitizedFlow: JsonRecord = {
                ...flow,
                flowData: sanitizeFlowDataForWorkspaceExport(flow.flowData, componentNodes, canonicalOrigin)
            }
            for (const key of ['chatbotConfig', 'analytic', 'speechToText', 'textToSpeech', 'followUpPrompts'] as const) {
                if (flow[key] !== undefined) sanitizedFlow[key] = sanitizeJsonConfig(flow[key])
            }
            return sanitizedFlow
        })
    }
    sanitized.CustomTemplate = mapRecords(sanitized.CustomTemplate, (template) => ({
        ...template,
        flowData: sanitizeTemplateFlowData(template, componentNodes, canonicalOrigin)
    }))
    sanitized.AssistantCustom = mapRecords(sanitized.AssistantCustom, (assistant) => ({
        ...assistant,
        details: sanitizeAssistantDetails(assistant.details, componentNodes, canonicalOrigin)
    }))
    sanitized.DocumentStore = mapRecords(sanitized.DocumentStore, (store) => {
        const sanitizedStore: JsonRecord = {
            ...store,
            loaders: sanitizeDocumentStoreLoaders(store.loaders, componentNodes)
        }
        for (const [key, category] of [
            ['vectorStoreConfig', 'Vector Stores'],
            ['embeddingConfig', 'Embeddings'],
            ['recordManagerConfig', 'Record Manager']
        ] as const) {
            if (store[key] !== undefined) {
                sanitizedStore[key] = sanitizePersistedDocumentStoreComponent(store[key], componentNodes, category)
            }
        }
        return sanitizedStore
    })
    return sanitized as unknown as WorkspaceImportData
}
