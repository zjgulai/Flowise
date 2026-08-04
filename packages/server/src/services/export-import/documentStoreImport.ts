import { StatusCodes } from 'http-status-codes'
import { type EntityManager } from 'typeorm'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { parseCanonicalDocumentStoreReference } from '../documentstore/documentStoreReferences'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { createDocumentStoreGenerationId } from '../documentstore/documentStoreVersion'
import { v4 as uuidv4 } from 'uuid'
import { DocumentStoreStatus } from '../../Interface'

const PORTABLE_DOCUMENT_STORE_TEXT_BYTES = 65_535
const PORTABLE_DOCUMENT_STORE_LABEL_LENGTH = 255
const MAX_IMPORTED_LOADERS = 1_000
const MAX_IMPORTED_FILES_PER_LOADER = 1_000
const MAX_IMPORTED_JSON_DEPTH = 20
const MAX_IMPORTED_JSON_NODES = 20_000
const MAX_IMPORTED_COMPONENT_NAME_LENGTH = 256
const MAX_IMPORTED_LOADER_ID_LENGTH = 36
const MAX_IMPORTED_DOCUMENT_STORE_ID_LENGTH = 256
const MAX_IMPORTED_CHUNKS = 100_000
const MAX_IMPORTED_REFERENCE_IDS = 100_000

const failInvalidDocumentStoreImport = (): never => {
    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store import')
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const assertBoundedSafeJson = (value: unknown, depth = 0, budget = { remaining: MAX_IMPORTED_JSON_NODES }): void => {
    if (depth > MAX_IMPORTED_JSON_DEPTH || budget.remaining <= 0) failInvalidDocumentStoreImport()
    budget.remaining -= 1
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) failInvalidDocumentStoreImport()
        return
    }
    if (typeof value === 'string') {
        if (value.includes('\0')) failInvalidDocumentStoreImport()
        return
    }
    if (Array.isArray(value)) {
        for (const entry of value) assertBoundedSafeJson(entry, depth + 1, budget)
        return
    }
    if (!isPlainRecord(value)) failInvalidDocumentStoreImport()
    const record = value as Record<string, unknown>
    for (const [key, entry] of Object.entries(record)) {
        if (!key || key.length > 256 || key.includes('\0') || key === '__proto__' || key === 'prototype' || key === 'constructor') {
            failInvalidDocumentStoreImport()
        }
        assertBoundedSafeJson(entry, depth + 1, budget)
    }
}

const parseBoundedImportJson = (value: unknown): unknown => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > PORTABLE_DOCUMENT_STORE_TEXT_BYTES) {
        failInvalidDocumentStoreImport()
    }
    const serializedValue = value as string
    let parsed: unknown
    try {
        parsed = JSON.parse(serializedValue)
    } catch {
        return failInvalidDocumentStoreImport()
    }
    assertBoundedSafeJson(parsed)
    return parsed
}

const readOptionalBoundedString = (
    source: Record<string, unknown>,
    key: string,
    maxLength: number,
    required = false
): string | undefined => {
    const value = source[key]
    if (value === undefined || value === null) {
        if (required) failInvalidDocumentStoreImport()
        return undefined
    }
    if (typeof value !== 'string' || !value || value.length > maxLength || value.includes('\0')) failInvalidDocumentStoreImport()
    return value as string
}

const readOptionalSafeCount = (source: Record<string, unknown>, key: string): number | undefined => {
    const value = source[key]
    if (value === undefined || value === null) return undefined
    if (!Number.isSafeInteger(value) || (value as number) < 0) failInvalidDocumentStoreImport()
    return value as number
}

const sanitizeImportedLoaderFiles = (value: unknown): Array<Record<string, unknown>> | undefined => {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value) || value.length > MAX_IMPORTED_FILES_PER_LOADER) failInvalidDocumentStoreImport()
    const files = value as unknown[]
    const allowedKeys = new Set(['id', 'name', 'mimePrefix', 'size', 'status', 'uploaded'])
    const seenFileIds = new Set<string>()
    return files.map((file) => {
        if (!isPlainRecord(file)) failInvalidDocumentStoreImport()
        const fileRecord = file as Record<string, unknown>
        if (Object.keys(fileRecord).some((key) => !allowedKeys.has(key))) failInvalidDocumentStoreImport()
        const uploaded = readOptionalBoundedString(fileRecord, 'uploaded', 64, true)
        if (!uploaded || !Number.isFinite(Date.parse(uploaded))) failInvalidDocumentStoreImport()
        const size = readOptionalSafeCount(fileRecord, 'size')
        if (size === undefined) failInvalidDocumentStoreImport()
        const id = readOptionalBoundedString(fileRecord, 'id', MAX_IMPORTED_LOADER_ID_LENGTH, true)
        if (!id || id !== id.trim() || seenFileIds.has(id)) failInvalidDocumentStoreImport()
        const safeId = id as string
        seenFileIds.add(safeId)
        return {
            id: safeId,
            name: readOptionalBoundedString(fileRecord, 'name', 1_024, true),
            mimePrefix: readOptionalBoundedString(fileRecord, 'mimePrefix', 255, true),
            size,
            status: DocumentStoreStatus.STALE,
            uploaded
        }
    })
}

const sanitizeImportedLoaders = (value: unknown): string => {
    const parsed = parseBoundedImportJson(value)
    if (!Array.isArray(parsed) || parsed.length > MAX_IMPORTED_LOADERS) failInvalidDocumentStoreImport()
    const parsedLoaders = parsed as unknown[]
    const allowedKeys = new Set([
        'id',
        'loaderId',
        'loaderName',
        'loaderConfig',
        'splitterId',
        'splitterName',
        'splitterConfig',
        'totalChunks',
        'totalChars',
        'status',
        'storeId',
        'files',
        'source',
        'credential',
        'versionToken'
    ])
    const seenLoaderIds = new Set<string>()
    const loaders = parsedLoaders.map((loader) => {
        if (!isPlainRecord(loader)) failInvalidDocumentStoreImport()
        const loaderRecord = loader as Record<string, unknown>
        if (Object.keys(loaderRecord).some((key) => !allowedKeys.has(key))) failInvalidDocumentStoreImport()
        const loaderConfig = loaderRecord.loaderConfig
        if (!isPlainRecord(loaderConfig)) failInvalidDocumentStoreImport()
        const splitterConfig = loaderRecord.splitterConfig
        if (splitterConfig !== undefined && splitterConfig !== null && !isPlainRecord(splitterConfig)) failInvalidDocumentStoreImport()

        const id = readOptionalBoundedString(loaderRecord, 'id', MAX_IMPORTED_LOADER_ID_LENGTH, true)
        if (!id || id !== id.trim() || seenLoaderIds.has(id)) failInvalidDocumentStoreImport()
        const safeId = id as string
        seenLoaderIds.add(safeId)
        const sanitized: Record<string, unknown> = {
            id: safeId,
            loaderId: readOptionalBoundedString(loaderRecord, 'loaderId', MAX_IMPORTED_COMPONENT_NAME_LENGTH, true),
            loaderConfig,
            status: DocumentStoreStatus.STALE
        }
        for (const [key, maxLength] of [
            ['loaderName', PORTABLE_DOCUMENT_STORE_LABEL_LENGTH],
            ['splitterId', MAX_IMPORTED_COMPONENT_NAME_LENGTH],
            ['splitterName', PORTABLE_DOCUMENT_STORE_LABEL_LENGTH],
            ['credential', MAX_IMPORTED_COMPONENT_NAME_LENGTH]
        ] as const) {
            const field = readOptionalBoundedString(loaderRecord, key, maxLength)
            if (field !== undefined) sanitized[key] = field
        }
        if (splitterConfig !== undefined && splitterConfig !== null) sanitized.splitterConfig = splitterConfig
        for (const key of ['totalChunks', 'totalChars'] as const) {
            const count = readOptionalSafeCount(loaderRecord, key)
            if (count !== undefined) sanitized[key] = count
        }
        const files = sanitizeImportedLoaderFiles(loaderRecord.files)
        if (files !== undefined) sanitized.files = files
        return sanitized
    })
    const serialized = JSON.stringify(loaders)
    if (Buffer.byteLength(serialized, 'utf8') > PORTABLE_DOCUMENT_STORE_TEXT_BYTES) failInvalidDocumentStoreImport()
    return serialized
}

const sanitizeImportedComponentConfig = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null
    const parsed = parseBoundedImportJson(value)
    if (!isPlainRecord(parsed)) failInvalidDocumentStoreImport()
    const parsedConfig = parsed as Record<string, unknown>
    if (Object.keys(parsedConfig).some((key) => key !== 'name' && key !== 'config')) failInvalidDocumentStoreImport()
    const name = readOptionalBoundedString(parsedConfig, 'name', MAX_IMPORTED_COMPONENT_NAME_LENGTH, true)
    if (!name || !isPlainRecord(parsedConfig.config)) failInvalidDocumentStoreImport()
    const serialized = JSON.stringify({ name, config: parsedConfig.config })
    if (Buffer.byteLength(serialized, 'utf8') > PORTABLE_DOCUMENT_STORE_TEXT_BYTES) failInvalidDocumentStoreImport()
    return serialized
}

/**
 * Document-store materialization and concurrency state is server-owned.
 * Import keeps strictly parsed recovery metadata, creates a new lifetime and
 * forces a new local process/upsert before runtime use.
 */
export const sanitizeDocumentStoresForImport = (documentStores: unknown[]): DocumentStore[] => {
    const seenStoreIds = new Set<string>()
    return documentStores.map((documentStore) => {
        if (!documentStore || typeof documentStore !== 'object' || Array.isArray(documentStore)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store import')
        }
        const source = documentStore as Record<string, unknown>
        if (
            typeof source.id !== 'string' ||
            !source.id ||
            source.id !== source.id.trim() ||
            source.id.length > MAX_IMPORTED_DOCUMENT_STORE_ID_LENGTH ||
            source.id.includes('\0') ||
            typeof source.name !== 'string' ||
            !source.name.trim() ||
            source.name.length > PORTABLE_DOCUMENT_STORE_LABEL_LENGTH ||
            source.name.includes('\0') ||
            typeof source.workspaceId !== 'string' ||
            !source.workspaceId ||
            source.workspaceId.length > 256 ||
            source.workspaceId.includes('\0') ||
            (source.description !== undefined && source.description !== null && typeof source.description !== 'string') ||
            (typeof source.description === 'string' &&
                (source.description.length > PORTABLE_DOCUMENT_STORE_LABEL_LENGTH || source.description.includes('\0')))
        ) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store import')
        }
        if (seenStoreIds.has(source.id)) failInvalidDocumentStoreImport()
        seenStoreIds.add(source.id)

        return {
            id: source.id,
            name: source.name,
            description: typeof source.description === 'string' ? source.description : null,
            loaders: sanitizeImportedLoaders(source.loaders),
            whereUsed: '[]',
            status: DocumentStoreStatus.STALE,
            vectorStoreConfig: sanitizeImportedComponentConfig(source.vectorStoreConfig),
            embeddingConfig: sanitizeImportedComponentConfig(source.embeddingConfig),
            recordManagerConfig: sanitizeImportedComponentConfig(source.recordManagerConfig),
            workspaceId: source.workspaceId,
            generationId: createDocumentStoreGenerationId()
        } as DocumentStore
    })
}

export const rebuildDocumentStoreUsageForImport = (
    documentStores: DocumentStore[],
    flowReferences: Array<{ id: string; documentStoreIds: string[] }>
): DocumentStore[] => {
    const usage = new Map(documentStores.map((store) => [store.id, new Set<string>()]))
    for (const reference of flowReferences) {
        if (
            typeof reference.id !== 'string' ||
            !reference.id ||
            reference.id.length > 256 ||
            reference.id.includes('\0') ||
            !Array.isArray(reference.documentStoreIds)
        ) {
            failInvalidDocumentStoreImport()
        }
        for (const storeId of reference.documentStoreIds) usage.get(storeId)?.add(reference.id)
    }
    return documentStores.map((store) => {
        const whereUsed = JSON.stringify([...(usage.get(store.id) ?? [])])
        if (Buffer.byteLength(whereUsed, 'utf8') > PORTABLE_DOCUMENT_STORE_TEXT_BYTES) failInvalidDocumentStoreImport()
        return { ...store, whereUsed }
    })
}

export interface DocumentStoreUsageReferenceForImport {
    id: string
    documentStoreIds: string[]
}

const assertImportReferenceId = (value: unknown): string => {
    if (
        typeof value !== 'string' ||
        !value ||
        value !== value.trim() ||
        value.length > MAX_IMPORTED_DOCUMENT_STORE_ID_LENGTH ||
        value.includes('\0')
    ) {
        failInvalidDocumentStoreImport()
    }
    return value as string
}

export const mergeDocumentStoreUsageReferencesForImport = (
    references: DocumentStoreUsageReferenceForImport[]
): DocumentStoreUsageReferenceForImport[] => {
    if (!Array.isArray(references) || references.length > MAX_IMPORTED_REFERENCE_IDS) failInvalidDocumentStoreImport()
    const merged = new Map<string, Set<string>>()
    for (const reference of references) {
        if (!isPlainRecord(reference) || !Array.isArray(reference.documentStoreIds)) failInvalidDocumentStoreImport()
        const flowId = assertImportReferenceId(reference.id)
        const storeIds = merged.get(flowId) ?? new Set<string>()
        for (const storeId of reference.documentStoreIds) storeIds.add(assertImportReferenceId(storeId))
        merged.set(flowId, storeIds)
    }
    return [...merged].map(([id, documentStoreIds]) => ({ id, documentStoreIds: [...documentStoreIds] }))
}

export const extractCustomAssistantDocumentStoreUsageForImport = (assistants: unknown[]): DocumentStoreUsageReferenceForImport[] => {
    if (!Array.isArray(assistants) || assistants.length > MAX_IMPORTED_REFERENCE_IDS) failInvalidDocumentStoreImport()
    const references: DocumentStoreUsageReferenceForImport[] = []
    for (const assistant of assistants) {
        if (!isPlainRecord(assistant) || assistant.type !== 'CUSTOM' || typeof assistant.details !== 'string') {
            failInvalidDocumentStoreImport()
        }
        const assistantRecord = assistant as Record<string, unknown>
        let details: unknown
        try {
            details = JSON.parse(assistantRecord.details as string)
        } catch {
            return failInvalidDocumentStoreImport()
        }
        if (!isPlainRecord(details) || !Array.isArray(details.documentStores)) failInvalidDocumentStoreImport()
        const detailsRecord = details as Record<string, unknown>
        const documentStores = detailsRecord.documentStores as unknown[]
        const documentStoreIds = documentStores.map((store: unknown) => {
            if (!isPlainRecord(store)) failInvalidDocumentStoreImport()
            return assertImportReferenceId((store as Record<string, unknown>).id)
        })
        if (documentStoreIds.length === 0) continue
        references.push({ id: assertImportReferenceId(detailsRecord.flowId), documentStoreIds })
    }
    return references
}

export const preflightDocumentStoreReferencesForImport = async (
    _manager: EntityManager,
    documentStores: DocumentStore[],
    usageReferences: DocumentStoreUsageReferenceForImport[],
    validationOnlyStoreIds: string[],
    workspaceId: string
): Promise<DocumentStore[]> => {
    if (!workspaceId) failInvalidDocumentStoreImport()
    const mergedReferences = mergeDocumentStoreUsageReferencesForImport(usageReferences)
    const importedStoreIds = new Set(documentStores.map((store) => assertImportReferenceId(store.id)))
    if (importedStoreIds.size !== documentStores.length) failInvalidDocumentStoreImport()

    const allReferencedStoreIds = new Set<string>()
    for (const reference of mergedReferences) {
        for (const storeId of reference.documentStoreIds) allReferencedStoreIds.add(storeId)
    }
    if (!Array.isArray(validationOnlyStoreIds) || validationOnlyStoreIds.length > MAX_IMPORTED_REFERENCE_IDS) {
        failInvalidDocumentStoreImport()
    }
    for (const storeId of validationOnlyStoreIds) allReferencedStoreIds.add(assertImportReferenceId(storeId))

    if ([...allReferencedStoreIds].some((storeId) => !importedStoreIds.has(storeId))) failInvalidDocumentStoreImport()
    return rebuildDocumentStoreUsageForImport(documentStores, mergedReferences)
}

export const applyDocumentStoreUsageReferencesForImport = async (
    _manager: EntityManager,
    usageReferences: DocumentStoreUsageReferenceForImport[],
    importedStoreIds: string[],
    workspaceId: string
): Promise<void> => {
    if (!workspaceId) failInvalidDocumentStoreImport()
    const mergedReferences = mergeDocumentStoreUsageReferencesForImport(usageReferences)
    const importedIds = new Set(importedStoreIds.map((storeId) => assertImportReferenceId(storeId)))
    if (importedIds.size !== importedStoreIds.length) failInvalidDocumentStoreImport()

    for (const reference of mergedReferences) {
        for (const storeId of reference.documentStoreIds) {
            if (!importedIds.has(storeId)) failInvalidDocumentStoreImport()
        }
    }
}

const cloneImportPayload = <T>(value: T): T => {
    if (!isPlainRecord(value)) failInvalidDocumentStoreImport()
    const clone: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const collectionName of [
        'DocumentStore',
        'DocumentStoreFileChunk',
        'AgentFlow',
        'AgentFlowV2',
        'AssistantFlow',
        'ChatFlow',
        'CustomTemplate',
        'AssistantCustom'
    ]) {
        const collection = clone[collectionName]
        if (collection === undefined) continue
        if (!Array.isArray(collection)) failInvalidDocumentStoreImport()
        const collectionEntries = collection as unknown[]
        clone[collectionName] = collectionEntries.map((entry: unknown) => (isPlainRecord(entry) ? { ...entry } : entry))
    }
    return clone as T
}

const readRequiredImportIdentifier = (source: Record<string, unknown>, key: string, maxLength: number): string => {
    const value = readOptionalBoundedString(source, key, maxLength, true)
    if (!value || value !== value.trim()) failInvalidDocumentStoreImport()
    return value as string
}

const getImportedLoaderIdsByStore = (documentStores: unknown[]): Map<string, Set<string>> => {
    const loaderIdsByStore = new Map<string, Set<string>>()
    for (const store of documentStores) {
        if (!isPlainRecord(store)) failInvalidDocumentStoreImport()
        const storeRecord = store as Record<string, unknown>
        const storeId = readRequiredImportIdentifier(storeRecord, 'id', MAX_IMPORTED_DOCUMENT_STORE_ID_LENGTH)
        if (loaderIdsByStore.has(storeId) || typeof storeRecord.loaders !== 'string') failInvalidDocumentStoreImport()
        let loaders: unknown
        try {
            loaders = JSON.parse(storeRecord.loaders as string)
        } catch {
            return failInvalidDocumentStoreImport()
        }
        if (!Array.isArray(loaders)) failInvalidDocumentStoreImport()
        const loaderEntries = loaders as unknown[]
        const loaderIds = new Set<string>()
        for (const loader of loaderEntries) {
            if (!isPlainRecord(loader)) failInvalidDocumentStoreImport()
            const loaderId = readRequiredImportIdentifier(loader as Record<string, unknown>, 'id', MAX_IMPORTED_LOADER_ID_LENGTH)
            if (loaderIds.has(loaderId)) failInvalidDocumentStoreImport()
            loaderIds.add(loaderId)
        }
        loaderIdsByStore.set(storeId, loaderIds)
    }
    return loaderIdsByStore
}

const sanitizeDocumentStoreChunksForImport = (
    chunks: unknown[],
    documentStores: unknown[],
    idMap: ReadonlyMap<string, string>
): DocumentStoreFileChunk[] => {
    if (chunks.length > MAX_IMPORTED_CHUNKS) failInvalidDocumentStoreImport()
    const loaderIdsByStore = getImportedLoaderIdsByStore(documentStores)
    const allowedKeys = new Set(['id', 'docId', 'storeId', 'chunkNo', 'pageContent', 'metadata'])
    const seenSourceIds = new Set<string>()
    const seenChunkPositions = new Set<string>()

    return chunks.map((chunk) => {
        if (!isPlainRecord(chunk)) failInvalidDocumentStoreImport()
        const chunkRecord = chunk as Record<string, unknown>
        if (Object.keys(chunkRecord).some((key) => !allowedKeys.has(key))) failInvalidDocumentStoreImport()
        const sourceId = readRequiredImportIdentifier(chunkRecord, 'id', MAX_IMPORTED_LOADER_ID_LENGTH)
        const docId = readRequiredImportIdentifier(chunkRecord, 'docId', MAX_IMPORTED_LOADER_ID_LENGTH)
        const sourceStoreId = readRequiredImportIdentifier(chunkRecord, 'storeId', MAX_IMPORTED_DOCUMENT_STORE_ID_LENGTH)
        const chunkNo = readOptionalSafeCount(chunkRecord, 'chunkNo')
        const pageContent = chunkRecord.pageContent
        const metadata = chunkRecord.metadata
        const targetStoreId = idMap.get(sourceStoreId)

        if (
            seenSourceIds.has(sourceId) ||
            chunkNo === undefined ||
            chunkNo < 1 ||
            typeof pageContent !== 'string' ||
            pageContent.includes('\0') ||
            Buffer.byteLength(pageContent, 'utf8') > PORTABLE_DOCUMENT_STORE_TEXT_BYTES ||
            typeof metadata !== 'string' ||
            !targetStoreId ||
            !loaderIdsByStore.get(sourceStoreId)?.has(docId)
        ) {
            failInvalidDocumentStoreImport()
        }
        const parsedMetadata = parseBoundedImportJson(metadata)
        if (!isPlainRecord(parsedMetadata)) failInvalidDocumentStoreImport()

        const position = `${sourceStoreId}\0${docId}\0${chunkNo}`
        if (seenChunkPositions.has(position)) failInvalidDocumentStoreImport()
        seenSourceIds.add(sourceId)
        seenChunkPositions.add(position)
        return {
            id: uuidv4(),
            docId,
            storeId: targetStoreId,
            chunkNo,
            pageContent,
            metadata
        } as DocumentStoreFileChunk
    })
}

const remapDocumentStoreFlowData = (flowData: unknown, idMap: ReadonlyMap<string, string>): unknown => {
    if (typeof flowData !== 'string') return flowData
    let parsed: unknown
    try {
        parsed = JSON.parse(flowData)
    } catch {
        return flowData
    }
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.nodes)) return flowData

    let changed = false
    for (const node of parsed.nodes) {
        if (!isPlainRecord(node) || !isPlainRecord(node.data) || !isPlainRecord(node.data.inputs)) continue
        const name = node.data.name
        if (name === 'documentStore' || name === 'documentStoreVS') {
            const reference = parseCanonicalDocumentStoreReference(node.data.inputs.selectedStore, false)
            const replacement = reference ? idMap.get(reference.storeId) : undefined
            if (replacement) {
                node.data.inputs.selectedStore = replacement
                changed = true
            }
        }

        const knowledgeInputName =
            name === 'agentAgentflow'
                ? 'agentKnowledgeDocumentStores'
                : name === 'retrieverAgentflow'
                ? 'retrieverKnowledgeDocumentStores'
                : undefined
        if (!knowledgeInputName) continue
        const knowledgeStores = node.data.inputs[knowledgeInputName]
        if (!Array.isArray(knowledgeStores)) continue
        for (const knowledgeStore of knowledgeStores) {
            if (!isPlainRecord(knowledgeStore)) continue
            const reference = parseCanonicalDocumentStoreReference(knowledgeStore.documentStore, true)
            if (!reference) continue
            const replacement = idMap.get(reference.storeId)
            if (!replacement) continue
            knowledgeStore.documentStore = replacement + reference.suffix
            changed = true
        }
    }
    return changed ? JSON.stringify(parsed) : flowData
}

const remapCustomAssistantDetails = (details: unknown, idMap: ReadonlyMap<string, string>): unknown => {
    if (typeof details !== 'string') return details
    let parsed: unknown
    try {
        parsed = JSON.parse(details)
    } catch {
        return details
    }
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.documentStores)) return details

    let changed = false
    for (const store of parsed.documentStores) {
        if (!isPlainRecord(store) || typeof store.id !== 'string') continue
        const replacement = idMap.get(store.id)
        if (!replacement) continue
        store.id = replacement
        changed = true
    }
    return changed ? JSON.stringify(parsed) : details
}

/**
 * Gives every imported store a new primary ID and rewrites only typed
 * DocumentStore reference fields. Arbitrary JSON-looking user strings are
 * never parsed or rewritten.
 */
export const remapDocumentStoreIdsForImport = <T>(payload: T, sourceIds: string[]): { data: T; idMap: Map<string, string> } => {
    if (!Array.isArray(sourceIds) || sourceIds.length > MAX_IMPORTED_REFERENCE_IDS) failInvalidDocumentStoreImport()
    const idMap = new Map<string, string>()
    for (const sourceId of sourceIds) {
        if (
            typeof sourceId !== 'string' ||
            !sourceId ||
            sourceId !== sourceId.trim() ||
            sourceId.length > MAX_IMPORTED_DOCUMENT_STORE_ID_LENGTH ||
            sourceId.includes('\0') ||
            idMap.has(sourceId)
        ) {
            failInvalidDocumentStoreImport()
        }
        idMap.set(sourceId, uuidv4())
    }
    const data = cloneImportPayload(payload)
    if (!isPlainRecord(data)) failInvalidDocumentStoreImport()
    const dataRecord = data as Record<string, unknown>

    const documentStores = dataRecord.DocumentStore
    if (!Array.isArray(documentStores) || documentStores.length !== sourceIds.length) failInvalidDocumentStoreImport()
    const documentStoreEntries = documentStores as unknown[]
    const payloadStoreIds = new Set<string>()
    for (const store of documentStoreEntries) {
        if (!isPlainRecord(store)) failInvalidDocumentStoreImport()
        const sourceId = readRequiredImportIdentifier(store as Record<string, unknown>, 'id', MAX_IMPORTED_DOCUMENT_STORE_ID_LENGTH)
        if (!idMap.has(sourceId) || payloadStoreIds.has(sourceId)) failInvalidDocumentStoreImport()
        payloadStoreIds.add(sourceId)
    }

    if (!Array.isArray(dataRecord.DocumentStoreFileChunk)) failInvalidDocumentStoreImport()
    dataRecord.DocumentStoreFileChunk = sanitizeDocumentStoreChunksForImport(
        dataRecord.DocumentStoreFileChunk as unknown[],
        documentStoreEntries,
        idMap
    )

    for (const store of documentStoreEntries) {
        if (!isPlainRecord(store) || typeof store.id !== 'string') failInvalidDocumentStoreImport()
        const storeRecord = store as Record<string, unknown>
        const replacement = idMap.get(storeRecord.id as string)
        if (!replacement) failInvalidDocumentStoreImport()
        storeRecord.id = replacement
    }
    for (const collectionName of ['AgentFlow', 'AgentFlowV2', 'AssistantFlow', 'ChatFlow', 'CustomTemplate']) {
        const flows = dataRecord[collectionName]
        if (!Array.isArray(flows)) continue
        for (const flow of flows) {
            if (isPlainRecord(flow)) flow.flowData = remapDocumentStoreFlowData(flow.flowData, idMap)
        }
    }
    if (Array.isArray(dataRecord.AssistantCustom)) {
        for (const assistant of dataRecord.AssistantCustom) {
            if (isPlainRecord(assistant)) assistant.details = remapCustomAssistantDetails(assistant.details, idMap)
        }
    }
    return { data: data as T, idMap }
}

/**
 * Import is create-only. EntityManager.save can update a row that appears
 * after duplicate-id preflight, so use a single INSERT and let a unique-key
 * race roll back the surrounding import transaction instead of overwriting it.
 */
export const insertDocumentStoresForImport = async (manager: EntityManager, documentStores: DocumentStore[]): Promise<void> => {
    if (documentStores.length === 0) return
    try {
        await manager.insert(DocumentStore, documentStores)
    } catch (error) {
        const candidate = error as {
            code?: unknown
            errno?: unknown
            message?: unknown
            driverError?: { code?: unknown; errno?: unknown; message?: unknown }
        }
        const code = candidate?.driverError?.code ?? candidate?.code
        const errno = candidate?.driverError?.errno ?? candidate?.errno
        const message = candidate?.driverError?.message ?? candidate?.message
        const sqliteDocumentStoreIdCollision =
            code === 'SQLITE_CONSTRAINT' &&
            typeof message === 'string' &&
            /(?:UNIQUE constraint failed: document_store\.id|document_store\.id.*must be unique)/i.test(message)
        if (
            code === '23505' ||
            code === 'SQLITE_CONSTRAINT_UNIQUE' ||
            code === 'ER_DUP_ENTRY' ||
            errno === 1062 ||
            sqliteDocumentStoreIdCollision
        ) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store import changed concurrently')
        }
        throw error
    }
}

export const insertDocumentStoreChunksForImport = async (
    manager: EntityManager,
    chunks: DocumentStoreFileChunk[],
    batchSize = 900
): Promise<void> => {
    try {
        for (let index = 0; index < chunks.length; index += batchSize) {
            await manager.insert(DocumentStoreFileChunk, chunks.slice(index, index + batchSize))
        }
    } catch {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store chunk import changed concurrently')
    }
}
