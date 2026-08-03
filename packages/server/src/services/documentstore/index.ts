import { Document } from '@langchain/core/documents'
import {
    addArrayFilesToStorage,
    addSingleFileToStorage,
    extractResponseContent,
    getFileFromStorage,
    getFileFromUpload,
    getStorageSize,
    ICommonObject,
    IDocument,
    mapExtToInputField,
    mapMimeTypeToInputField,
    removeFilesFromStorage,
    removeSpecificFileFromStorage,
    removeSpecificFileFromUpload,
    resolveSafeChatModelSelection
} from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { cloneDeep, isEqual, omit } from 'lodash'
import * as path from 'path'
import { DataSource, In } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import {
    addLoaderSource,
    ChatType,
    DocumentStoreDTO,
    DocumentStoreStatus,
    IComponentNodes,
    IDocumentStoreFileChunkPagedResponse,
    IDocumentStoreLoader,
    IDocumentStoreLoaderFile,
    IDocumentStoreLoaderForPreview,
    IDocumentStoreLoaderResponse,
    IDocumentStoreRefreshData,
    IDocumentStoreUpsertData,
    IDocumentStoreWhereUsed,
    IExecuteDocStoreUpsert,
    IExecutePreviewLoader,
    IExecuteProcessLoader,
    IExecuteVectorStoreInsert,
    INodeData,
    IOverrideConfig,
    MODE
} from '../../Interface'
import { UsageCacheManager } from '../../UsageCacheManager'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { UpsertHistory } from '../../database/entities/UpsertHistory'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { validateFileMimeTypeAndExtensionMatch } from '../../utils/fileValidation'
import { databaseEntities, getAppVersion, saveUpsertFlowData } from '../../utils'
import { DOCUMENT_STORE_BASE_FOLDER, INPUT_PARAMS_TYPE, OMIT_QUEUE_JOB_DATA } from '../../utils/constants'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { DOCUMENTSTORE_TOOL_DESCRIPTION_PROMPT_GENERATOR } from '../../utils/prompt'
import { checkStorage, updateStorageUsage } from '../../utils/quotaUsage'
import { Telemetry } from '../../utils/telemetry'
import nodesService from '../nodes'
import credentialsService from '../credentials'
import { createWorkspaceOAuth2RefreshCapability } from '../oauth2CredentialRefresh'
import {
    createDocumentStoreRevisionPredicate,
    type DocumentStoreRevisionIdentity,
    getDocumentStoreMutablePatch,
    updateExistingDocumentStore
} from './documentStoreRevision'
import {
    createDocumentStoreGenerationFingerprint,
    createDocumentStoreGenerationId,
    createDocumentStoreVersionToken,
    createDocumentStoreVersionTokenFromClaim,
    matchesDocumentStoreVersionClaim,
    type DocumentStoreOperationIdentity
} from './documentStoreVersion'
import { waitForDocumentStoreQueueResult } from '../../queue/documentStoreQueueError'
import { updateDocumentStoreUsageWithManager } from './documentStoreUsage'

const BYTES_PER_MEBIBYTE = 1024 * 1024
const MAX_COMPONENT_NAME_LENGTH = 256
const DOCUMENT_STORE_COMPONENT_BASE_CLASSES = {
    'Document Loaders': ['Document'],
    'Text Splitters': ['TextSplitter'],
    Embeddings: ['Embeddings'],
    'Vector Stores': ['VectorStoreRetriever', 'BaseRetriever'],
    'Record Manager': ['RecordManager']
} as const
export const DOCUMENT_STORE_DENIED_LOADERS = new Set(['documentStore', 'vectorStoreToDocument', 'unstructuredFolderLoader', 'folderFiles'])
const DOCUMENT_STORE_DENIED_VECTOR_STORES = new Set(['documentStoreVS', 'memoryVectorStore'])

type DocumentStoreComponentCategory = keyof typeof DOCUMENT_STORE_COMPONENT_BASE_CLASSES

const isDisallowedDocumentStoreComponent = (component: any, componentName: string, category: DocumentStoreComponentCategory): boolean => {
    if (category === 'Document Loaders') return DOCUMENT_STORE_DENIED_LOADERS.has(componentName)
    if (category === 'Vector Stores' && DOCUMENT_STORE_DENIED_VECTOR_STORES.has(componentName)) return true
    return (
        (category === 'Embeddings' || category === 'Vector Stores' || category === 'Record Manager') &&
        Array.isArray(component?.tags) &&
        component.tags.includes('LlamaIndex')
    )
}

const createDocumentStoreOperationRevision = (entity: DocumentStoreRevisionIdentity): DocumentStoreOperationIdentity => ({
    id: entity.id,
    workspaceId: entity.workspaceId,
    generationFingerprint: createDocumentStoreGenerationFingerprint(entity),
    revision: entity.revision
})

const assertDocumentStoreOperationRevision = (
    entity: DocumentStoreRevisionIdentity,
    operationRevision: DocumentStoreOperationIdentity | undefined,
    conflictMessage: string
): void => {
    if (!operationRevision) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, conflictMessage)
    }
    if (
        entity.id !== operationRevision.id ||
        entity.workspaceId !== operationRevision.workspaceId ||
        !matchesDocumentStoreVersionClaim(entity, operationRevision)
    ) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, conflictMessage)
    }
}

const advanceDocumentStoreOperationRevision = (
    operationRevision: DocumentStoreOperationIdentity | undefined,
    entity: DocumentStoreRevisionIdentity
): void => {
    if (!operationRevision) return
    if (
        entity.id !== operationRevision.id ||
        entity.workspaceId !== operationRevision.workspaceId ||
        !matchesDocumentStoreVersionClaim(
            {
                id: entity.id,
                workspaceId: entity.workspaceId,
                generationId: entity.generationId,
                revision: operationRevision.revision
            },
            operationRevision
        )
    ) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store operation ownership changed concurrently')
    }
    operationRevision.revision = entity.revision
    operationRevision.generationFingerprint = createDocumentStoreGenerationFingerprint(entity)
}

const isPlainRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value)

const getDocumentStoreUploadPaths = (files: Express.Multer.File[]): string[] => [
    ...new Set(
        files
            .map((file) => file.path ?? file.key)
            .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
    )
]

const cleanupDocumentStoreUploads = async (files: Express.Multer.File[]): Promise<void> => {
    const uploadPaths = getDocumentStoreUploadPaths(files)
    const cleanupResults = await Promise.allSettled(uploadPaths.map((uploadPath) => removeSpecificFileFromUpload(uploadPath)))
    const failedCount = cleanupResults.filter((result) => result.status === 'rejected').length
    if (failedCount > 0) {
        logger.error('document_store_upload_cleanup_failed', { failedCount, totalCount: uploadPaths.length })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store upload cleanup failed')
    }
}

export const resolveDocumentStoreFileInputField = (mimeType: string, originalName: string, loaderId: string): string => {
    if (loaderId === 'unstructuredFileLoader') return 'fileObject'
    const fileInputFieldFromExt = mapExtToInputField(path.extname(originalName))
    if (fileInputFieldFromExt !== 'txtFile') return fileInputFieldFromExt
    const fileInputFieldFromMimeType = mapMimeTypeToInputField(mimeType)
    return fileInputFieldFromMimeType !== 'txtFile' ? fileInputFieldFromMimeType : 'txtFile'
}

export const resolveSafeDocumentStoreComponent = (
    componentNodes: IComponentNodes,
    componentName: unknown,
    config: unknown,
    expectedCategory: DocumentStoreComponentCategory
): any => {
    if (
        typeof componentName !== 'string' ||
        !componentName.trim() ||
        componentName !== componentName.trim() ||
        componentName.length > MAX_COMPONENT_NAME_LENGTH ||
        !isPlainRecord(config)
    ) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
    }

    const component = componentNodes[componentName]
    const allowedBaseClasses = DOCUMENT_STORE_COMPONENT_BASE_CLASSES[expectedCategory]
    if (
        !component ||
        component.name !== componentName ||
        component.category !== expectedCategory ||
        !Array.isArray(component.baseClasses) ||
        !allowedBaseClasses.some((baseClass) => component.baseClasses.includes(baseClass)) ||
        typeof component.filePath !== 'string' ||
        !component.filePath ||
        !Array.isArray(component.inputs) ||
        isDisallowedDocumentStoreComponent(component, componentName, expectedCategory)
    ) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
    }

    const allowedInputs = new Set(component.inputs.map((input: any) => input?.name).filter((name: unknown) => typeof name === 'string'))
    const credentialInputName = isPlainRecord(component.credential) ? component.credential.name : undefined
    if (typeof credentialInputName === 'string') allowedInputs.add(credentialInputName)
    allowedInputs.add('FLOWISE_CREDENTIAL_ID')
    if (expectedCategory === 'Vector Stores') {
        for (const retrievalInput of ['topK', 'searchType', 'fetchK', 'lambda']) allowedInputs.add(retrievalInput)
    }
    for (const key of Object.keys(config)) {
        if (key === 'customFunction' || !allowedInputs.has(key)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
        }
    }
    return component
}

const assertDocumentStoreComponentCredential = async (
    component: any,
    config: Record<string, any>,
    workspaceId: string,
    explicitCredential?: unknown
): Promise<void> => {
    const credentialInputName = isPlainRecord(component.credential) ? component.credential.name : undefined
    const candidates = [
        explicitCredential,
        config.FLOWISE_CREDENTIAL_ID,
        typeof credentialInputName === 'string' ? config[credentialInputName] : undefined
    ].filter((candidate) => candidate !== undefined && candidate !== null && candidate !== '')
    const credentialIds = [...new Set(candidates)]
    if (credentialIds.length > 1 || credentialIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256)) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component credential')
    }
    if (credentialIds.length === 1) {
        try {
            await credentialsService.assertCredentialInWorkspace(credentialIds[0] as string, workspaceId)
        } catch {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store component credential not found')
        }
    }
}

const validateDocumentProcessingComponents = async (
    componentNodes: IComponentNodes,
    data: IDocumentStoreLoaderForPreview,
    workspaceId: string
): Promise<void> => {
    const loaderConfig = isPlainRecord(data.loaderConfig) ? data.loaderConfig : undefined
    if (!loaderConfig) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
    const loader = resolveSafeDocumentStoreComponent(componentNodes, data.loaderId, loaderConfig, 'Document Loaders')
    await assertDocumentStoreComponentCredential(loader, loaderConfig, workspaceId, data.credential)

    if (data.splitterId) {
        const splitterConfig = isPlainRecord(data.splitterConfig) ? data.splitterConfig : undefined
        if (!splitterConfig) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
        const splitter = resolveSafeDocumentStoreComponent(componentNodes, data.splitterId, splitterConfig, 'Text Splitters')
        await assertDocumentStoreComponentCredential(splitter, splitterConfig, workspaceId)
    }
}

const validateDocumentVectorComponents = async (
    componentNodes: IComponentNodes,
    data: ICommonObject,
    workspaceId: string,
    requireCoreComponents = true
): Promise<void> => {
    const validateOne = async (
        name: unknown,
        config: unknown,
        category: DocumentStoreComponentCategory,
        required: boolean
    ): Promise<void> => {
        if (!name && !required && (!config || (isPlainRecord(config) && Object.keys(config).length === 0))) return
        const safeConfig = isPlainRecord(config) ? config : undefined
        if (!safeConfig) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
        const component = resolveSafeDocumentStoreComponent(componentNodes, name, safeConfig, category)
        await assertDocumentStoreComponentCredential(component, safeConfig, workspaceId)
    }

    await validateOne(data.embeddingName, data.embeddingConfig, 'Embeddings', requireCoreComponents)
    await validateOne(data.vectorStoreName, data.vectorStoreConfig, 'Vector Stores', requireCoreComponents)
    await validateOne(data.recordManagerName, data.recordManagerConfig, 'Record Manager', false)
}

const parsePersistedComponentConfig = (value: string | null | undefined): ICommonObject => {
    if (!value) return {}
    try {
        const parsed = JSON.parse(value)
        if (!isPlainRecord(parsed) || typeof parsed.name !== 'string' || !isPlainRecord(parsed.config)) {
            throw new Error('invalid')
        }
        return parsed
    } catch {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid persisted document store component configuration')
    }
}

const arePersistedComponentConfigsEquivalent = (
    previousValue: string | null | undefined,
    nextValue: string | null | undefined
): boolean => {
    if (previousValue === nextValue) return true
    return isEqual(parsePersistedComponentConfig(previousValue), parsePersistedComponentConfig(nextValue))
}

const validateResolvedDocumentVectorComponents = async (
    appDataSource: DataSource,
    componentNodes: IComponentNodes,
    storeId: string,
    data: ICommonObject,
    workspaceId: string,
    requireCoreComponents: boolean,
    operationRevision?: DocumentStoreOperationIdentity
): Promise<{ entity: DocumentStore; resolved: ICommonObject }> => {
    const entity = await appDataSource.getRepository(DocumentStore).findOneBy({ id: storeId, workspaceId })
    if (!entity) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
    assertDocumentStoreOperationRevision(entity, operationRevision, 'Document store vector configuration changed concurrently')
    const persistedEmbedding = parsePersistedComponentConfig(entity.embeddingConfig)
    const persistedVectorStore = parsePersistedComponentConfig(entity.vectorStoreConfig)
    const persistedRecordManager = parsePersistedComponentConfig(entity.recordManagerConfig)
    const resolved = {
        ...data,
        embeddingName: data.embeddingName || persistedEmbedding.name,
        embeddingConfig: data.embeddingConfig || persistedEmbedding.config,
        vectorStoreName: data.vectorStoreName || persistedVectorStore.name,
        vectorStoreConfig: data.vectorStoreConfig || persistedVectorStore.config,
        recordManagerName: data.recordManagerName || persistedRecordManager.name,
        recordManagerConfig: data.recordManagerConfig || persistedRecordManager.config
    }
    await validateDocumentVectorComponents(componentNodes, resolved, workspaceId, requireCoreComponents)
    return { entity, resolved }
}

const isConfirmedMissingStorageError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false
    const candidate = error as {
        code?: unknown
        status?: unknown
        statusCode?: unknown
        response?: { status?: unknown }
        $metadata?: { httpStatusCode?: unknown }
    }
    return (
        candidate.code === 'ENOENT' ||
        candidate.status === StatusCodes.NOT_FOUND ||
        candidate.statusCode === StatusCodes.NOT_FOUND ||
        candidate.response?.status === StatusCodes.NOT_FOUND ||
        candidate.$metadata?.httpStatusCode === StatusCodes.NOT_FOUND
    )
}

const reconcileDocumentStoreStorageUsage = async (
    orgId: string,
    workspaceId: string,
    usageCacheManager: UsageCacheManager
): Promise<void> => {
    const totalBytes = await getStorageSize(orgId)
    await updateStorageUsage(orgId, workspaceId, totalBytes / BYTES_PER_MEBIBYTE, usageCacheManager)
}

const failDocumentStoreStorageCleanup = (event: string): never => {
    logger.error(event, { failedCount: 1, phase: 'storage' })
    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store storage cleanup failed')
}

const removeDocumentStoreLoaderFiles = async (
    files: IDocumentStoreLoaderFile[],
    orgId: string,
    workspaceId: string,
    storeId: string,
    usageCacheManager: UsageCacheManager,
    event: string
): Promise<void> => {
    let idempotentMissingCount = 0
    let accountingFailureCount = 0
    for (const file of files) {
        if (!file.name) failDocumentStoreStorageCleanup(event)
        let totalSize: number
        try {
            ;({ totalSize } = await removeSpecificFileFromStorage(orgId, DOCUMENT_STORE_BASE_FOLDER, storeId, file.name))
        } catch (error) {
            if (!isConfirmedMissingStorageError(error)) failDocumentStoreStorageCleanup(event)
            idempotentMissingCount += 1
            try {
                await reconcileDocumentStoreStorageUsage(orgId, workspaceId, usageCacheManager)
            } catch {
                accountingFailureCount += 1
            }
            continue
        }
        try {
            await updateStorageUsage(orgId, workspaceId, totalSize, usageCacheManager)
        } catch {
            accountingFailureCount += 1
        }
    }
    if (accountingFailureCount > 0) {
        logger.error(event, { failedCount: accountingFailureCount, phase: 'accounting' })
    }
    if (idempotentMissingCount > 0) {
        logger.warn(`${event}_idempotent_missing`, { idempotentMissingCount, totalCount: files.length })
    }
}

const removeDocumentStoreFolder = async (
    orgId: string,
    workspaceId: string,
    storeId: string,
    usageCacheManager: UsageCacheManager
): Promise<void> => {
    const event = 'document_store_delete_storage_cleanup_failed'
    let totalSize: number
    try {
        ;({ totalSize } = await removeFilesFromStorage(orgId, DOCUMENT_STORE_BASE_FOLDER, storeId))
    } catch (error) {
        if (!isConfirmedMissingStorageError(error)) failDocumentStoreStorageCleanup(event)
        try {
            await reconcileDocumentStoreStorageUsage(orgId, workspaceId, usageCacheManager)
        } catch {
            logger.error(event, { failedCount: 1, phase: 'accounting' })
        }
        logger.warn('document_store_delete_storage_idempotent_missing', { idempotentMissingCount: 1, totalCount: 1 })
        return
    }
    try {
        await updateStorageUsage(orgId, workspaceId, totalSize, usageCacheManager)
    } catch {
        logger.error(event, { failedCount: 1, phase: 'accounting' })
    }
}

const compensateCreatedDocumentStore = async (
    appDataSource: DataSource,
    orgId: string,
    workspaceId: string,
    createdDocumentStore: DocumentStoreRevisionIdentity,
    usageCacheManager: UsageCacheManager
): Promise<void> => {
    const storeId = createdDocumentStore.id
    if (createdDocumentStore.workspaceId !== workspaceId) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store creation compensation changed concurrently')
    }

    try {
        await appDataSource.transaction(async (transactionManager) => {
            await transactionManager.getRepository(DocumentStoreFileChunk).delete({ storeId })
            await transactionManager.getRepository(UpsertHistory).delete({ chatflowid: storeId })
            const deleteResult = await transactionManager
                .getRepository(DocumentStore)
                .delete(createDocumentStoreRevisionPredicate(createdDocumentStore))
            if (deleteResult?.affected !== 1) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store creation compensation changed concurrently')
            }
        })
    } catch (error) {
        logger.error('document_store_create_compensation_failed', { failedCount: 1, phase: 'database' })
        if (error instanceof InternalFlowiseError) throw error
        await markCreatedDocumentStoreForRecovery(appDataSource, createdDocumentStore, 'compensation')
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store creation compensation requires recovery')
    }

    // The database deletion is authoritative. Provider cleanup is deliberately
    // post-commit and best effort; a durable cleanup outbox remains necessary
    // to guarantee retries for provider or accounting failures.
    let totalSize: number
    try {
        ;({ totalSize } = await removeFilesFromStorage(orgId, DOCUMENT_STORE_BASE_FOLDER, storeId))
    } catch (error) {
        if (!isConfirmedMissingStorageError(error)) {
            logger.error('document_store_create_compensation_cleanup_failed', { failedCount: 1, phase: 'storage' })
            return
        }
        try {
            await reconcileDocumentStoreStorageUsage(orgId, workspaceId, usageCacheManager)
        } catch {
            logger.error('document_store_create_compensation_cleanup_failed', { failedCount: 1, phase: 'accounting' })
        }
        return
    }
    try {
        await updateStorageUsage(orgId, workspaceId, totalSize, usageCacheManager)
    } catch {
        logger.error('document_store_create_compensation_cleanup_failed', { failedCount: 1, phase: 'accounting' })
    }
}

const markCreatedDocumentStoreForRecovery = async (
    appDataSource: DataSource,
    operationIdentity: DocumentStoreRevisionIdentity,
    phase: 'provider' | 'compensation'
): Promise<void> => {
    try {
        const repository = appDataSource.getRepository(DocumentStore)
        await updateExistingDocumentStore(
            repository,
            operationIdentity as DocumentStore,
            { status: DocumentStoreStatus.STALE },
            'Document store recovery state changed concurrently'
        )
        logger.error('document_store_create_recovery_required', { failedCount: 1, phase })
    } catch (error) {
        logger.error('document_store_create_recovery_mark_failed', { failedCount: 1, phase })
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store recovery state update failed')
    }
}

export const handleCreatedDocumentStoreFailure = async (
    appDataSource: DataSource,
    orgId: string,
    workspaceId: string,
    createdDocumentStore: DocumentStoreRevisionIdentity,
    usageCacheManager: UsageCacheManager,
    providerSideEffectPossible: boolean
): Promise<void> => {
    if (createdDocumentStore.workspaceId !== workspaceId) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store recovery state changed concurrently')
    }
    if (providerSideEffectPossible) {
        await markCreatedDocumentStoreForRecovery(appDataSource, createdDocumentStore, 'provider')
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store vector upsert requires recovery')
    }
    await compensateCreatedDocumentStore(appDataSource, orgId, workspaceId, createdDocumentStore, usageCacheManager)
}

const getScopedDocumentStore = async (storeId: string, workspaceId: string): Promise<DocumentStore> => {
    if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
    const appServer = getRunningExpressApp()
    const entity = await appServer.AppDataSource.getRepository(DocumentStore).findOneBy({ id: storeId, workspaceId })
    if (!entity) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
    return entity
}

const resolveDocumentStoreChatModel = async (
    selectedChatModel: unknown,
    workspaceId: string
): Promise<ReturnType<typeof resolveSafeChatModelSelection>> => {
    const appServer = getRunningExpressApp()
    let safeChatModel: ReturnType<typeof resolveSafeChatModelSelection>
    try {
        safeChatModel = resolveSafeChatModelSelection(appServer.nodesPool.componentNodes, selectedChatModel)
    } catch {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid chat model selection')
    }
    if (safeChatModel.credentialId) {
        try {
            await credentialsService.assertCredentialInWorkspace(safeChatModel.credentialId, workspaceId)
        } catch {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Chat model credential not found')
        }
    }
    return safeChatModel
}

const parseRetrievalOverrides = (value: unknown, persistedConfig: ICommonObject): ICommonObject => {
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid vector store query overrides')
    }
    const overrides = value as Record<string, unknown>
    const allowed = new Set(['topK', 'searchType', 'fetchK', 'lambda'])
    for (const [key, candidate] of Object.entries(overrides)) {
        if (allowed.has(key)) continue
        if (Object.prototype.hasOwnProperty.call(persistedConfig, key) && isEqual(candidate, persistedConfig[key])) continue
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid vector store query overrides')
    }

    const parsed: ICommonObject = {}
    const parseBoundedInteger = (candidate: unknown, min: number, max: number): number => {
        const parsedValue = typeof candidate === 'string' && candidate.trim() ? Number(candidate) : candidate
        if (typeof parsedValue !== 'number' || !Number.isInteger(parsedValue) || parsedValue < min || parsedValue > max) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid vector store query overrides')
        }
        return parsedValue
    }
    if (overrides.topK !== undefined) parsed.topK = parseBoundedInteger(overrides.topK, 1, 100)
    if (overrides.fetchK !== undefined) parsed.fetchK = parseBoundedInteger(overrides.fetchK, 1, 500)
    if (overrides.searchType !== undefined) {
        if (overrides.searchType !== 'similarity' && overrides.searchType !== 'mmr') {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid vector store query overrides')
        }
        parsed.searchType = overrides.searchType
    }
    if (overrides.lambda !== undefined) {
        const lambda = typeof overrides.lambda === 'string' && overrides.lambda.trim() ? Number(overrides.lambda) : overrides.lambda
        if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid vector store query overrides')
        }
        parsed.lambda = lambda
    }
    return parsed
}

const createDocumentStore = async (newDocumentStore: DocumentStore, orgId: string) => {
    try {
        const appServer = getRunningExpressApp()

        const repository = appServer.AppDataSource.getRepository(DocumentStore)
        const documentStore = repository.create({
            ...getDocumentStoreMutablePatch(newDocumentStore),
            workspaceId: newDocumentStore.workspaceId,
            generationId: createDocumentStoreGenerationId()
        })
        const dbResponse = await repository.save(documentStore)
        const telemetryResults = await Promise.allSettled([
            (async () =>
                appServer.telemetry.sendTelemetry(
                    'document_store_created',
                    {
                        version: await getAppVersion()
                    },
                    orgId
                ))()
        ])
        const failedCount = telemetryResults.filter((result) => result.status === 'rejected').length
        if (failedCount > 0) {
            logger.error('document_store_create_observability_failed', {
                failedCount,
                totalCount: telemetryResults.length
            })
        }
        return dbResponse
    } catch {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to create document store')
    }
}

const getAllDocumentStores = async (
    workspaceId: string,
    page: number = -1,
    limit: number = -1,
    search?: string,
    orderBy?: 'name' | 'updatedDate',
    order?: 'asc' | 'desc'
) => {
    try {
        const appServer = getRunningExpressApp()
        const sortColumn = orderBy === 'name' ? 'doc_store.name' : 'doc_store.updatedDate'
        const sortDirection = order === 'asc' ? 'ASC' : 'DESC'
        const queryBuilder = appServer.AppDataSource.getRepository(DocumentStore)
            .createQueryBuilder('doc_store')
            .orderBy(sortColumn, sortDirection)
            .addOrderBy('doc_store.id', 'ASC')

        if (page > 0 && limit > 0) {
            queryBuilder.skip((page - 1) * limit)
            queryBuilder.take(limit)
        }
        queryBuilder.andWhere('doc_store.workspaceId = :workspaceId', { workspaceId })
        if (search) {
            queryBuilder.andWhere(`(LOWER(doc_store.name) LIKE :search OR LOWER(COALESCE(doc_store.description, '')) LIKE :search)`, {
                search: `%${search.toLowerCase()}%`
            })
        }

        const [data, total] = await queryBuilder.getManyAndCount()

        if (page > 0 && limit > 0) {
            return { data, total }
        } else {
            return data
        }
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.getAllDocumentStores - ${getErrorMessage(error)}`
        )
    }
}

const MAX_EXPORT_RELATION_QUERY_IDS = 400
const MAX_EXPORT_RELATION_ROWS = 10_000

const getAllDocumentFileChunksByDocumentStoreIds = async (documentStoreIds: string[]) => {
    const appServer = getRunningExpressApp()
    const repository = appServer.AppDataSource.getRepository(DocumentStoreFileChunk)
    const chunks: DocumentStoreFileChunk[] = []
    for (let index = 0; index < documentStoreIds.length; index += MAX_EXPORT_RELATION_QUERY_IDS) {
        const batch = documentStoreIds.slice(index, index + MAX_EXPORT_RELATION_QUERY_IDS)
        const rows = await repository.find({
            where: { storeId: In(batch) },
            order: { id: 'ASC' },
            take: MAX_EXPORT_RELATION_ROWS - chunks.length + 1
        })
        if (rows.length > MAX_EXPORT_RELATION_ROWS - chunks.length) {
            throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '文档片段超过单次可恢复导出的安全上限')
        }
        chunks.push(...rows)
    }
    return chunks
}

const deleteLoaderFromDocumentStore = async (
    storeId: string,
    docId: string,
    orgId: string,
    workspaceId: string,
    usageCacheManager: UsageCacheManager,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    try {
        const appServer = getRunningExpressApp()
        const documentStoreRepository = appServer.AppDataSource.getRepository(DocumentStore)
        const entity = await documentStoreRepository.findOneBy({
            id: storeId,
            workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
        }
        assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document store loader changed concurrently')

        const originalLoaders = entity.loaders
        const originalRevision = entity.revision
        const existingLoaders = JSON.parse(originalLoaders)
        if (!Array.isArray(existingLoaders)) throw new Error('invalid document store loaders')
        const found = existingLoaders.find((loader: IDocumentStoreLoader) => loader.id === docId)
        if (found) {
            const remainingLoadersJson = JSON.stringify(existingLoaders.filter((loader: IDocumentStoreLoader) => loader.id !== docId))
            const deletedEntity = await appServer.AppDataSource.transaction(async (transactionManager) => {
                await transactionManager.getRepository(DocumentStoreFileChunk).delete({ storeId, docId: found.id })
                const finalResult = await transactionManager
                    .getRepository(DocumentStore)
                    .update(createDocumentStoreRevisionPredicate(entity), {
                        loaders: remainingLoadersJson,
                        status: DocumentStoreStatus.STALE
                    })
                if (finalResult.affected !== 1) {
                    throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store loader changed concurrently')
                }

                return {
                    ...entity,
                    loaders: remainingLoadersJson,
                    status: DocumentStoreStatus.STALE,
                    revision: originalRevision + 1
                }
            })

            if (found.files?.length) {
                try {
                    await removeDocumentStoreLoaderFiles(
                        found.files,
                        orgId,
                        workspaceId,
                        storeId,
                        usageCacheManager,
                        'document_store_loader_delete_storage_cleanup_failed'
                    )
                } catch {
                    // The database transaction is authoritative. A durable
                    // cleanup outbox is required to retry provider orphans.
                }
            }
            return deletedEntity
        } else {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store loader not found')
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to delete document store loader')
    }
}

const getDocumentStoreById = async (storeId: string, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const entity = await appServer.AppDataSource.getRepository(DocumentStore).findOneBy({
            id: storeId,
            workspaceId: workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: documentStoreServices.getDocumentStoreById - Document store ${storeId} not found`
            )
        }
        return entity
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.getDocumentStoreById - ${getErrorMessage(error)}`
        )
    }
}

const getUsedChatflowNames = async (entity: DocumentStore, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        if (entity.whereUsed) {
            const whereUsed = JSON.parse(entity.whereUsed)
            const updatedWhereUsed: IDocumentStoreWhereUsed[] = []
            for (let i = 0; i < whereUsed.length; i++) {
                const associatedChatflow = await appServer.AppDataSource.getRepository(ChatFlow).findOne({
                    where: { id: whereUsed[i], workspaceId: workspaceId },
                    select: ['id', 'name']
                })
                if (associatedChatflow) {
                    updatedWhereUsed.push({
                        id: whereUsed[i],
                        name: associatedChatflow.name
                    })
                }
            }
            return updatedWhereUsed
        }
        return []
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.getUsedChatflowNames - ${getErrorMessage(error)}`
        )
    }
}

// Get chunks for a specific loader or store
const getDocumentStoreFileChunks = async (
    appDataSource: DataSource,
    storeId: string,
    docId: string,
    workspaceId: string,
    pageNo: number = 1
) => {
    try {
        const entity = await appDataSource.getRepository(DocumentStore).findOneBy({
            id: storeId,
            workspaceId: workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: documentStoreServices.getDocumentStoreById - Document store ${storeId} not found`
            )
        }
        const loaders = JSON.parse(entity.loaders)

        let found: IDocumentStoreLoader | undefined
        if (docId !== 'all') {
            found = loaders.find((loader: IDocumentStoreLoader) => loader.id === docId)
            if (!found) {
                throw new InternalFlowiseError(
                    StatusCodes.NOT_FOUND,
                    `Error: documentStoreServices.getDocumentStoreById - Document loader ${docId} not found`
                )
            }
        }
        if (found) {
            found.id = docId
            found.status = entity.status
        }

        let characters = 0
        if (docId === 'all') {
            loaders.forEach((loader: IDocumentStoreLoader) => {
                characters += loader.totalChars || 0
            })
        } else {
            characters = found?.totalChars || 0
        }

        const PAGE_SIZE = 50
        const skip = (pageNo - 1) * PAGE_SIZE
        const take = PAGE_SIZE
        let whereCondition: any = { storeId, docId }
        if (docId === 'all') {
            whereCondition = { storeId: storeId }
        }
        const count = await appDataSource.getRepository(DocumentStoreFileChunk).count({
            where: whereCondition
        })
        const chunksWithCount = await appDataSource.getRepository(DocumentStoreFileChunk).find({
            skip,
            take,
            where: whereCondition,
            order: {
                chunkNo: 'ASC'
            }
        })

        if (!chunksWithCount) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chunks with docId: ${docId} not found`)
        }

        const response: IDocumentStoreFileChunkPagedResponse = {
            chunks: chunksWithCount,
            count: count,
            file: found,
            currentPage: pageNo,
            storeName: entity.name,
            description: entity.description,
            workspaceId: entity.workspaceId,
            versionToken: createDocumentStoreVersionToken(entity),
            docId: docId,
            characters
        }
        return response
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.getDocumentStoreFileChunks - ${getErrorMessage(error)}`
        )
    }
}

const deleteDocumentStore = async (
    storeId: string,
    orgId: string,
    workspaceId: string,
    usageCacheManager: UsageCacheManager,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    try {
        const appServer = getRunningExpressApp()
        const documentStoreRepository = appServer.AppDataSource.getRepository(DocumentStore)
        const entity = await documentStoreRepository.findOneBy({
            id: storeId,
            workspaceId: workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store ${storeId} not found`)
        }
        assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document store changed concurrently')

        const deletedResult = await appServer.AppDataSource.transaction(async (transactionManager) => {
            await transactionManager.getRepository(DocumentStoreFileChunk).delete({ storeId })
            await transactionManager.getRepository(UpsertHistory).delete({ chatflowid: storeId })
            const deletedStore = await transactionManager.getRepository(DocumentStore).delete(createDocumentStoreRevisionPredicate(entity))
            if (deletedStore.affected !== 1) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store changed concurrently')
            }

            return { deleted: deletedStore.affected }
        })

        try {
            await removeDocumentStoreFolder(orgId, workspaceId, entity.id, usageCacheManager)
        } catch {
            // The database transaction is authoritative. A durable cleanup
            // outbox is required to retry provider orphans.
        }
        return deletedResult
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to delete document store')
    }
}

const deleteDocumentStoreFileChunk = async (
    storeId: string,
    docId: string,
    chunkId: string,
    workspaceId: string,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    try {
        const appServer = getRunningExpressApp()
        const entity = await appServer.AppDataSource.getRepository(DocumentStore).findOneBy({
            id: storeId,
            workspaceId: workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store ${storeId} not found`)
        }
        assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document chunk changed concurrently')
        const loaders = JSON.parse(entity.loaders)
        const found = loaders.find((ldr: IDocumentStoreLoader) => ldr.id === docId)
        if (!found) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store loader ${docId} not found`)
        }

        const tbdChunk = await appServer.AppDataSource.getRepository(DocumentStoreFileChunk).findOneBy({
            id: chunkId,
            storeId,
            docId
        })
        if (!tbdChunk) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document chunk not found')
        }
        found.totalChunks = Math.max(0, (found.totalChunks ?? 0) - 1)
        found.totalChars = Math.max(0, (found.totalChars ?? 0) - tbdChunk.pageContent.length)
        const loadersJson = JSON.stringify(loaders)
        await appServer.AppDataSource.transaction(async (transactionManager) => {
            const deletion = await transactionManager.getRepository(DocumentStoreFileChunk).delete({ id: chunkId, storeId, docId })
            if (deletion.affected !== 1) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document chunk not found')
            await updateExistingDocumentStore(
                transactionManager.getRepository(DocumentStore),
                entity,
                { loaders: loadersJson, status: DocumentStoreStatus.STALE },
                'Document chunk changed concurrently'
            )
        })
        return getDocumentStoreFileChunks(appServer.AppDataSource, storeId, docId, workspaceId)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to delete document chunk')
    }
}

const deleteVectorStoreFromStore = async (
    storeId: string,
    workspaceId: string,
    docId: string | undefined,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    try {
        const appServer = getRunningExpressApp()
        const componentNodes = appServer.nodesPool.componentNodes
        const repository = appServer.AppDataSource.getRepository(DocumentStore)
        const entity = await repository.findOneBy({
            id: storeId,
            workspaceId: workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store ${storeId} not found`)
        }
        assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document store vector state changed concurrently')
        if (entity.status !== DocumentStoreStatus.UPSERTED) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store vector index is not available')
        }

        if (!entity.embeddingConfig) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Embedding for Document store ${storeId} not found`)
        }

        if (!entity.vectorStoreConfig) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Vector Store for Document store ${storeId} not found`)
        }

        if (!entity.recordManagerConfig) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Record Manager for Document Store ${storeId} is needed to delete data from Vector Store`
            )
        }

        const embeddingConfig = parsePersistedComponentConfig(entity.embeddingConfig)
        const vectorStoreConfig = parsePersistedComponentConfig(entity.vectorStoreConfig)
        const recordManagerConfig = parsePersistedComponentConfig(entity.recordManagerConfig)
        const resolvedDeleteConfiguration = {
            storeId: entity.id,
            embeddingName: embeddingConfig.name,
            embeddingConfig: embeddingConfig.config,
            vectorStoreName: vectorStoreConfig.name,
            vectorStoreConfig: vectorStoreConfig.config,
            recordManagerName: recordManagerConfig.name,
            recordManagerConfig: recordManagerConfig.config
        }
        await validateDocumentVectorComponents(componentNodes, resolvedDeleteConfiguration, workspaceId, true)

        await updateExistingDocumentStore(
            repository,
            entity,
            { status: DocumentStoreStatus.UPSERTING },
            'Document store vector state changed concurrently'
        )
        const claimedIdentity: DocumentStoreRevisionIdentity = {
            id: entity.id,
            workspaceId: entity.workspaceId,
            generationId: entity.generationId,
            revision: entity.revision
        }

        try {
            const options: ICommonObject = {
                chatflowid: storeId,
                appDataSource: appServer.AppDataSource,
                databaseEntities,
                workspaceId,
                logger,
                refreshOAuth2Credential: createWorkspaceOAuth2RefreshCapability(workspaceId)
            }

            // Get Record Manager Instance
            const recordManagerObj = await _createRecordManagerObject(componentNodes, resolvedDeleteConfiguration, options)

            // Get Embeddings Instance
            const embeddingObj = await _createEmbeddingsObject(componentNodes, resolvedDeleteConfiguration, options)

            // Get Vector Store Node Data
            const vStoreNodeData = _createVectorStoreNodeData(componentNodes, resolvedDeleteConfiguration, embeddingObj, recordManagerObj)

            // Get Vector Store Instance
            const vectorStoreObj = await _createVectorStoreObject(componentNodes, resolvedDeleteConfiguration, vStoreNodeData)
            const idsToDelete: string[] = [] // empty ids because we get it dynamically from the record manager

            // Call the delete method of the vector store
            if (vectorStoreObj.vectorStoreMethods.delete) {
                await vectorStoreObj.vectorStoreMethods.delete(vStoreNodeData, idsToDelete, { ...options, docId })
            }
        } catch (error) {
            try {
                await updateExistingDocumentStore(
                    repository,
                    claimedIdentity as DocumentStore,
                    { status: DocumentStoreStatus.STALE },
                    'Document store vector state changed concurrently'
                )
            } catch (recoveryError) {
                if (recoveryError instanceof InternalFlowiseError) throw recoveryError
                throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store vector delete recovery failed')
            }
            if (error instanceof InternalFlowiseError && error.statusCode === StatusCodes.CONFLICT) throw error
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store vector deletion failed')
        }

        await updateExistingDocumentStore(
            repository,
            entity,
            { status: DocumentStoreStatus.SYNC },
            'Document store vector state changed concurrently'
        )
        return { deleted: true, versionToken: createDocumentStoreVersionToken(entity) }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store vector deletion failed')
    }
}

const editDocumentStoreFileChunk = async (
    storeId: string,
    docId: string,
    chunkId: string,
    content: string,
    metadata: ICommonObject,
    workspaceId: string,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    try {
        const appServer = getRunningExpressApp()
        const entity = await appServer.AppDataSource.getRepository(DocumentStore).findOneBy({
            id: storeId,
            workspaceId: workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store ${storeId} not found`)
        }
        assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document chunk changed concurrently')
        const loaders = JSON.parse(entity.loaders)
        const found = loaders.find((ldr: IDocumentStoreLoader) => ldr.id === docId)
        if (!found) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store loader ${docId} not found`)
        }

        const editChunk = await appServer.AppDataSource.getRepository(DocumentStoreFileChunk).findOneBy({
            id: chunkId,
            storeId,
            docId
        })
        if (!editChunk) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document chunk not found')
        }
        found.totalChars = Math.max(0, (found.totalChars ?? 0) - editChunk.pageContent.length + content.length)
        const loadersJson = JSON.stringify(loaders)
        await appServer.AppDataSource.transaction(async (transactionManager) => {
            const chunkUpdate = await transactionManager
                .getRepository(DocumentStoreFileChunk)
                .update({ id: chunkId, storeId, docId }, { pageContent: content, metadata: JSON.stringify(metadata) })
            if (chunkUpdate.affected !== 1) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document chunk not found')
            await updateExistingDocumentStore(
                transactionManager.getRepository(DocumentStore),
                entity,
                { loaders: loadersJson, status: DocumentStoreStatus.STALE },
                'Document chunk changed concurrently'
            )
        })
        return getDocumentStoreFileChunks(appServer.AppDataSource, storeId, docId, workspaceId)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to edit document chunk')
    }
}

const updateDocumentStore = async (
    documentStore: DocumentStore,
    updatedDocumentStore: DocumentStore,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    try {
        const appServer = getRunningExpressApp()
        assertDocumentStoreOperationRevision(documentStore, operationIdentity, 'Document store changed concurrently')
        const metadataPatch = {
            ...(updatedDocumentStore.name !== undefined ? { name: updatedDocumentStore.name } : {}),
            ...(updatedDocumentStore.description !== undefined ? { description: updatedDocumentStore.description } : {})
        }
        return await updateExistingDocumentStore(
            appServer.AppDataSource.getRepository(DocumentStore),
            documentStore,
            metadataPatch,
            'Document store changed concurrently'
        )
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to update document store')
    }
}

const _saveFileToStorage = async (
    fileBase64: string,
    entity: DocumentStore,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager
) => {
    await checkStorage(orgId, subscriptionId, usageCacheManager)

    const splitDataURI = fileBase64.split(',')
    const filename = splitDataURI.pop()?.split(':')[1] ?? ''
    const bf = Buffer.from(splitDataURI.pop() || '', 'base64')
    const mimePrefix = splitDataURI.pop()
    let mime = ''
    if (mimePrefix) {
        mime = mimePrefix.split(';')[0].split(':')[1]
    }
    const { totalSize } = await addSingleFileToStorage(mime, bf, filename, orgId, DOCUMENT_STORE_BASE_FOLDER, entity.id)
    await updateStorageUsage(orgId, workspaceId, totalSize, usageCacheManager)

    return {
        id: uuidv4(),
        name: filename,
        mimePrefix: mime,
        size: bf.length,
        status: DocumentStoreStatus.NEW,
        uploaded: new Date()
    }
}

const _splitIntoChunks = async (
    appDataSource: DataSource,
    componentNodes: IComponentNodes,
    data: IDocumentStoreLoaderForPreview,
    workspaceId?: string
) => {
    try {
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
        await validateDocumentProcessingComponents(componentNodes, data, workspaceId)
        const componentOptions: ICommonObject = {
            appDataSource,
            databaseEntities,
            logger,
            workspaceId,
            skipVariables: true,
            refreshOAuth2Credential: createWorkspaceOAuth2RefreshCapability(workspaceId)
        }
        let splitterInstance = null
        if (data.splitterId && data.splitterConfig && Object.keys(data.splitterConfig).length > 0) {
            const nodeInstanceFilePath = componentNodes[data.splitterId].filePath as string
            const nodeModule = await import(nodeInstanceFilePath)
            const newNodeInstance = new nodeModule.nodeClass()
            let nodeData = {
                inputs: { ...data.splitterConfig },
                id: 'splitter_0'
            }
            splitterInstance = await newNodeInstance.init(nodeData, '', componentOptions)
        }
        if (!data.loaderId) return []
        const nodeInstanceFilePath = componentNodes[data.loaderId].filePath as string
        const nodeModule = await import(nodeInstanceFilePath)
        // doc loader configs
        const nodeData = {
            credential: data.credential || data.loaderConfig['FLOWISE_CREDENTIAL_ID'] || undefined,
            inputs: { ...data.loaderConfig, textSplitter: splitterInstance },
            outputs: { output: 'document' }
        }
        const options: ICommonObject = {
            chatflowid: uuidv4(),
            appDataSource,
            databaseEntities,
            logger,
            processRaw: true,
            workspaceId,
            skipVariables: true,
            refreshOAuth2Credential: createWorkspaceOAuth2RefreshCapability(workspaceId)
        }
        const docNodeInstance = new nodeModule.nodeClass()
        let docs: IDocument[] = await docNodeInstance.init(nodeData, '', options)
        return docs
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to split document store content')
    }
}

const _normalizeFilePaths = async (
    appDataSource: DataSource,
    data: IDocumentStoreLoaderForPreview,
    entity: DocumentStore | null,
    orgId: string,
    workspaceId: string
) => {
    const keys = Object.getOwnPropertyNames(data.loaderConfig)
    let rehydrated = false
    for (let i = 0; i < keys.length; i++) {
        const input = data.loaderConfig[keys[i]]
        if (!input) {
            continue
        }
        if (typeof input !== 'string') {
            continue
        }
        let documentStoreEntity: DocumentStore | null = entity
        if (input.startsWith('FILE-STORAGE::')) {
            if (!documentStoreEntity) {
                if (!workspaceId) {
                    throw new InternalFlowiseError(
                        StatusCodes.PRECONDITION_FAILED,
                        'workspaceId is required to resolve document store for FILE-STORAGE paths'
                    )
                }
                documentStoreEntity = await appDataSource.getRepository(DocumentStore).findOneBy({
                    id: data.storeId,
                    workspaceId
                })
                if (!documentStoreEntity) {
                    throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store ${data.storeId} not found`)
                }
            }
            const fileName = input.replace('FILE-STORAGE::', '')
            let files: string[] = []
            if (fileName.startsWith('[') && fileName.endsWith(']')) {
                files = JSON.parse(fileName)
            } else {
                files = [fileName]
            }
            const loaders = JSON.parse(documentStoreEntity.loaders)
            const currentLoader = loaders.find((ldr: IDocumentStoreLoader) => ldr.id === data.id)
            if (currentLoader) {
                const base64Files: string[] = []
                for (const file of files) {
                    const bf = await getFileFromStorage(file, orgId, DOCUMENT_STORE_BASE_FOLDER, documentStoreEntity.id)
                    // find the file entry that has the same name as the file
                    const uploadedFile = currentLoader.files.find((uFile: IDocumentStoreLoaderFile) => uFile.name === file)
                    const mimePrefix = 'data:' + uploadedFile.mimePrefix + ';base64'
                    const base64String = mimePrefix + ',' + bf.toString('base64') + `,filename:${file}`
                    base64Files.push(base64String)
                }
                data.loaderConfig[keys[i]] = JSON.stringify(base64Files)
                rehydrated = true
            }
        }
    }
    data.rehydrated = rehydrated
}

const previewChunksMiddleware = async (
    data: IDocumentStoreLoaderForPreview,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager
) => {
    try {
        const appServer = getRunningExpressApp()
        const appDataSource = appServer.AppDataSource
        const componentNodes = appServer.nodesPool.componentNodes
        await validateDocumentProcessingComponents(componentNodes, data, workspaceId)

        const executeData: IExecutePreviewLoader = {
            appDataSource,
            componentNodes,
            usageCacheManager,
            data,
            isPreviewOnly: true,
            orgId,
            workspaceId,
            subscriptionId
        }

        if (process.env.MODE === MODE.QUEUE) {
            const upsertQueue = appServer.queueManager.getQueue('upsert')
            const job = await upsertQueue.addJob(omit(executeData, OMIT_QUEUE_JOB_DATA))
            logger.debug(`[server]: [${orgId}]: Job added to queue: ${job.id}`)

            const queueEvents = upsertQueue.getQueueEvents()
            const result = await waitForDocumentStoreQueueResult<any>(job, queueEvents)

            if (!result) {
                throw new Error('Job execution failed')
            }
            return result
        }

        return await previewChunks(executeData)
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.previewChunksMiddleware - ${getErrorMessage(error)}`
        )
    }
}

export const previewChunks = async ({ appDataSource, componentNodes, data, orgId, workspaceId }: IExecutePreviewLoader) => {
    try {
        await validateDocumentProcessingComponents(componentNodes, data, workspaceId)
        if (data.preview) {
            if (
                data.loaderId === 'cheerioWebScraper' ||
                data.loaderId === 'puppeteerWebScraper' ||
                data.loaderId === 'playwrightWebScraper'
            ) {
                data.loaderConfig['limit'] = 3
            }
        }
        if (!data.rehydrated) {
            await _normalizeFilePaths(appDataSource, data, null, orgId, workspaceId)
        }
        let docs = await _splitIntoChunks(appDataSource, componentNodes, data, workspaceId)
        const totalChunks = docs.length
        // if -1, return all chunks
        if (data.previewChunkCount === -1) data.previewChunkCount = totalChunks
        // return all docs if the user ask for more than we have
        if (totalChunks <= (data.previewChunkCount || 0)) data.previewChunkCount = totalChunks
        // return only the first n chunks
        if (totalChunks > (data.previewChunkCount || 0)) docs = docs.slice(0, data.previewChunkCount)

        return { chunks: docs, totalChunks: totalChunks, previewChunkCount: data.previewChunkCount }
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.previewChunks - ${getErrorMessage(error)}`
        )
    }
}

const saveProcessingLoader = async (
    appDataSource: DataSource,
    data: IDocumentStoreLoaderForPreview,
    workspaceId: string,
    operationRevision?: DocumentStoreOperationIdentity
): Promise<IDocumentStoreLoaderResponse> => {
    try {
        const entity = await appDataSource.getRepository(DocumentStore).findOneBy({
            id: data.storeId,
            workspaceId: workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: documentStoreServices.saveProcessingLoader - Document store ${data.storeId} not found`
            )
        }
        assertDocumentStoreOperationRevision(entity, operationRevision, 'Document store loader changed concurrently')
        const existingLoaders = JSON.parse(entity.loaders)
        const newDocLoaderId = data.id || uuidv4()
        const found = existingLoaders.find((ldr: IDocumentStoreLoader) => ldr.id === newDocLoaderId)
        if (data.id && !found) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Document store loader update is invalid')
        }
        if (found) {
            if (!data.loaderId) data.loaderId = found.loaderId
            if (!data.loaderName) data.loaderName = found.loaderName
            if (!data.loaderConfig) data.loaderConfig = found.loaderConfig
            if (!data.splitterId) data.splitterId = found.splitterId
            if (!data.splitterName) data.splitterName = found.splitterName
            if (!data.splitterConfig) data.splitterConfig = found.splitterConfig
            if (found.credential) data.credential = found.credential
        }
        await validateDocumentProcessingComponents(getRunningExpressApp().nodesPool.componentNodes, data, workspaceId)
        if (found) {
            const foundIndex = existingLoaders.findIndex((ldr: IDocumentStoreLoader) => ldr.id === newDocLoaderId)

            if (!data.loaderId) data.loaderId = found.loaderId
            if (!data.loaderName) data.loaderName = found.loaderName
            if (!data.loaderConfig) data.loaderConfig = found.loaderConfig
            if (!data.splitterId) data.splitterId = found.splitterId
            if (!data.splitterName) data.splitterName = found.splitterName
            if (!data.splitterConfig) data.splitterConfig = found.splitterConfig
            if (found.credential) {
                data.credential = found.credential
            }

            let loader: IDocumentStoreLoader = {
                ...found,
                loaderId: data.loaderId,
                loaderName: data.loaderName,
                loaderConfig: data.loaderConfig,
                splitterId: data.splitterId,
                splitterName: data.splitterName,
                splitterConfig: data.splitterConfig,
                totalChunks: 0,
                totalChars: 0,
                status: DocumentStoreStatus.SYNCING
            }
            if (data.credential) {
                loader.credential = data.credential
            }

            existingLoaders[foundIndex] = loader
            entity.loaders = JSON.stringify(existingLoaders)
        } else {
            let loader: IDocumentStoreLoader = {
                id: newDocLoaderId,
                loaderId: data.loaderId,
                loaderName: data.loaderName,
                loaderConfig: data.loaderConfig,
                splitterId: data.splitterId,
                splitterName: data.splitterName,
                splitterConfig: data.splitterConfig,
                totalChunks: 0,
                totalChars: 0,
                status: DocumentStoreStatus.SYNCING
            }
            if (data.credential) {
                loader.credential = data.credential
            }
            existingLoaders.push(loader)
            entity.loaders = JSON.stringify(existingLoaders)
        }
        await updateExistingDocumentStore(
            appDataSource.getRepository(DocumentStore),
            entity,
            { loaders: entity.loaders, status: DocumentStoreStatus.STALE },
            'Document store loader changed concurrently'
        )
        advanceDocumentStoreOperationRevision(operationRevision, entity)
        const newLoaders = JSON.parse(entity.loaders)
        const newLoader = newLoaders.find((ldr: IDocumentStoreLoader) => ldr.id === newDocLoaderId)
        if (!newLoader) {
            throw new Error(`Loader ${newDocLoaderId} not found`)
        }
        newLoader.source = addLoaderSource(newLoader, true)
        newLoader.versionToken = createDocumentStoreVersionToken(entity)
        return newLoader
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to save document store loader')
    }
}

const markDocumentStoreMaterializationStale = async (
    appDataSource: DataSource,
    entity: DocumentStore,
    operationIdentity?: DocumentStoreOperationIdentity
): Promise<void> => {
    if (entity.status === DocumentStoreStatus.STALE) return
    await updateExistingDocumentStore(
        appDataSource.getRepository(DocumentStore),
        entity,
        { status: DocumentStoreStatus.STALE },
        'Document store loader changed concurrently'
    )
    advanceDocumentStoreOperationRevision(operationIdentity, entity)
}

export const processLoader = async ({
    appDataSource,
    componentNodes,
    data,
    docLoaderId,
    orgId,
    workspaceId,
    subscriptionId,
    usageCacheManager,
    operationIdentity
}: IExecuteProcessLoader) => {
    const entity = await appDataSource.getRepository(DocumentStore).findOneBy({
        id: data.storeId,
        workspaceId: workspaceId
    })
    if (!entity) {
        throw new InternalFlowiseError(
            StatusCodes.NOT_FOUND,
            `Error: documentStoreServices.processLoader - Document store ${data.storeId} not found`
        )
    }
    assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document store loader changed concurrently')
    await validateDocumentProcessingComponents(componentNodes, data, workspaceId)
    await markDocumentStoreMaterializationStale(appDataSource, entity, operationIdentity)
    await _saveChunksToStorage(
        appDataSource,
        componentNodes,
        data,
        entity,
        docLoaderId,
        orgId,
        workspaceId,
        subscriptionId,
        usageCacheManager,
        operationIdentity
    )
    return getDocumentStoreFileChunks(appDataSource, data.storeId as string, docLoaderId, workspaceId)
}

const processLoaderMiddleware = async (
    data: IDocumentStoreLoaderForPreview,
    docLoaderId: string,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager,
    isInternalRequest: boolean,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    try {
        const appServer = getRunningExpressApp()
        const appDataSource = appServer.AppDataSource
        const componentNodes = appServer.nodesPool.componentNodes
        const telemetry = appServer.telemetry
        const entity = await appDataSource.getRepository(DocumentStore).findOneBy({ id: data.storeId, workspaceId })
        if (!entity) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
        assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document store loader changed concurrently')
        await validateDocumentProcessingComponents(componentNodes, data, workspaceId)
        await markDocumentStoreMaterializationStale(appDataSource, entity, operationIdentity)

        const executeData: IExecuteProcessLoader = {
            appDataSource,
            componentNodes,
            data,
            docLoaderId,
            isProcessWithoutUpsert: true,
            telemetry,
            orgId,
            workspaceId,
            subscriptionId,
            usageCacheManager,
            operationIdentity
        }

        if (process.env.MODE === MODE.QUEUE) {
            const upsertQueue = appServer.queueManager.getQueue('upsert')
            const job = await upsertQueue.addJob(omit(executeData, OMIT_QUEUE_JOB_DATA))
            logger.debug(`[server]: [${orgId}]: Job added to queue: ${job.id}`)

            if (isInternalRequest) {
                return {
                    jobId: job.id,
                    acceptedVersionToken: createDocumentStoreVersionTokenFromClaim(operationIdentity)
                }
            }

            const queueEvents = upsertQueue.getQueueEvents()
            const result = await waitForDocumentStoreQueueResult<any>(job, queueEvents)

            if (!result) {
                throw new Error('Job execution failed')
            }
            return result
        }

        return await processLoader(executeData)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to process document store loader')
    }
}

const _saveChunksToStorage = async (
    appDataSource: DataSource,
    componentNodes: IComponentNodes,
    data: IDocumentStoreLoaderForPreview,
    entity: DocumentStore,
    newLoaderId: string,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager,
    operationRevision?: DocumentStoreOperationIdentity
) => {
    const re = new RegExp('^data.*;base64', 'i')

    try {
        //step 1: restore the full paths, if any
        await _normalizeFilePaths(appDataSource, data, entity, orgId, workspaceId)

        //step 2: split the file into chunks
        const response = await previewChunks({
            appDataSource,
            componentNodes,
            data,
            isPreviewOnly: false,
            orgId,
            workspaceId,
            subscriptionId,
            usageCacheManager
        })

        //step 3: remove all files associated with the loader
        const existingLoaders = JSON.parse(entity.loaders)
        const loader = existingLoaders.find((ldr: IDocumentStoreLoader) => ldr.id === newLoaderId)
        if (data.id) {
            const index = existingLoaders.indexOf(loader)
            if (index > -1) {
                if (!data.rehydrated && loader.files?.length) {
                    await removeDocumentStoreLoaderFiles(
                        loader.files,
                        orgId,
                        workspaceId,
                        entity.id,
                        usageCacheManager,
                        'document_store_loader_replace_storage_cleanup_failed'
                    )
                }
                existingLoaders.splice(index, 1)
            }
        }

        //step 4: save new file to storage
        let filesWithMetadata = []
        const keys = Object.getOwnPropertyNames(data.loaderConfig)
        for (let i = 0; i < keys.length; i++) {
            const input = data.loaderConfig[keys[i]]

            if (!input) {
                continue
            }
            if (typeof input !== 'string') {
                continue
            }
            if (input.startsWith('[') && input.endsWith(']')) {
                const files = JSON.parse(input)
                const fileNames: string[] = []
                for (let j = 0; j < files.length; j++) {
                    const file = files[j]
                    if (re.test(file)) {
                        const fileMetadata = await _saveFileToStorage(file, entity, orgId, workspaceId, subscriptionId, usageCacheManager)
                        fileNames.push(fileMetadata.name)
                        filesWithMetadata.push(fileMetadata)
                    }
                }
                data.loaderConfig[keys[i]] = 'FILE-STORAGE::' + JSON.stringify(fileNames)
            } else if (re.test(input)) {
                const fileNames: string[] = []
                const fileMetadata = await _saveFileToStorage(input, entity, orgId, workspaceId, subscriptionId, usageCacheManager)
                fileNames.push(fileMetadata.name)
                filesWithMetadata.push(fileMetadata)
                data.loaderConfig[keys[i]] = 'FILE-STORAGE::' + JSON.stringify(fileNames)
                break
            }
        }

        //step 5: update with the new files and loaderConfig
        if (filesWithMetadata.length > 0) {
            loader.loaderConfig = data.loaderConfig
            loader.files = filesWithMetadata
        }

        //step 6: update the loaders with the new loaderConfig
        if (data.id) {
            existingLoaders.push(loader)
        }

        const replacementChunks: DocumentStoreFileChunk[] = []
        if (response.chunks) {
            const totalChars = response.chunks.reduce((acc, chunk) => {
                if (chunk.pageContent) {
                    return acc + chunk.pageContent.length
                }
                return acc
            }, 0)
            replacementChunks.push(
                ...response.chunks.map((chunk: IDocument, index: number) => ({
                    docId: newLoaderId,
                    storeId: entity.id,
                    id: uuidv4(),
                    chunkNo: index + 1,
                    pageContent: sanitizeChunkContent(chunk.pageContent),
                    metadata: JSON.stringify(chunk.metadata)
                }))
            )
            // update the loader with the new metrics
            loader.totalChunks = response.totalChunks
            loader.totalChars = totalChars
        }
        loader.status = 'SYNC'
        // have a flag and iterate over the loaders and update the entity status to SYNC
        const allSynced = existingLoaders.every((ldr: IDocumentStoreLoader) => ldr.status === 'SYNC')
        const status = allSynced ? DocumentStoreStatus.SYNC : DocumentStoreStatus.STALE
        const loadersJson = JSON.stringify(existingLoaders)

        // Replace all child chunks and advance the parent revision atomically.
        // A stale parent rolls back both the delete and every inserted chunk.
        await appDataSource.transaction(async (transactionManager) => {
            const chunkRepository = transactionManager.getRepository(DocumentStoreFileChunk)
            await chunkRepository.delete({ storeId: entity.id, docId: newLoaderId })
            for (const chunk of replacementChunks) {
                await chunkRepository.save(chunkRepository.create(chunk))
            }
            await updateExistingDocumentStore(
                transactionManager.getRepository(DocumentStore),
                entity,
                { loaders: loadersJson, status },
                'Document store loader changed concurrently'
            )
        })
        advanceDocumentStoreOperationRevision(operationRevision, entity)

        return
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to save document store chunks')
    }
}

// remove null bytes from chunk content
const sanitizeChunkContent = (content: string) => {
    // eslint-disable-next-line no-control-regex
    return content.replaceAll(/\u0000/g, '')
}

// Get all component nodes
const getDocumentLoaders = async () => {
    try {
        const dbResponse = await nodesService.getAllNodesForCategory('Document Loaders')
        return dbResponse.filter((node) => !DOCUMENT_STORE_DENIED_LOADERS.has(node.name))
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.getDocumentLoaders - ${getErrorMessage(error)}`
        )
    }
}

const updateDocumentStoreUsage = async (chatId: string, storeIds: string | string[] | undefined, workspaceId?: string) => {
    try {
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
        const appServer = getRunningExpressApp()
        await appServer.AppDataSource.transaction((transactionManager) =>
            updateDocumentStoreUsageWithManager(transactionManager, chatId, storeIds, workspaceId)
        )
    } catch (error) {
        logger.error('[server]: Document store usage update failed', { failedCount: 1 })
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to update document store usage')
    }
}

const updateVectorStoreConfigOnly = async (data: ICommonObject, workspaceId: string, operationIdentity: DocumentStoreOperationIdentity) => {
    try {
        const appServer = getRunningExpressApp()
        const entity = await appServer.AppDataSource.getRepository(DocumentStore).findOneBy({
            id: data.storeId,
            workspaceId: workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document store ${data.storeId} not found`)
        }
        assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document store vector configuration changed concurrently')
        if (data.vectorStoreName || data.vectorStoreConfig) {
            await validateDocumentVectorComponents(appServer.nodesPool.componentNodes, data, workspaceId, false)
        }

        if (data.vectorStoreName) {
            const nextVectorStoreConfig = JSON.stringify({
                config: data.vectorStoreConfig,
                name: data.vectorStoreName
            })
            if (arePersistedComponentConfigsEquivalent(entity.vectorStoreConfig, nextVectorStoreConfig)) return entity

            return await updateExistingDocumentStore(
                appServer.AppDataSource.getRepository(DocumentStore),
                entity,
                { vectorStoreConfig: nextVectorStoreConfig, status: DocumentStoreStatus.STALE },
                'Document store vector configuration changed concurrently'
            )
        }
        return entity
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        logger.error('document_store_vector_configuration_update_failed', { failedCount: 1 })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to update document store vector configuration')
    }
}
/**
 * Saves vector store configuration to the document store entity.
 * Handles embedding, vector store, and record manager configurations.
 *
 * @example
 * // Strict mode: Only save what's provided, clear the rest
 * await saveVectorStoreConfig(ds, { storeId, embeddingName, embeddingConfig }, true, wsId)
 *
 * @example
 * // Lenient mode: Reuse existing configs if not provided
 * await saveVectorStoreConfig(ds, { storeId, vectorStoreName, vectorStoreConfig }, false, wsId)
 */
const saveVectorStoreConfig = async (
    appDataSource: DataSource,
    data: ICommonObject,
    isStrictSave = true,
    workspaceId: string,
    requireCoreComponents = false,
    operationRevision?: DocumentStoreOperationIdentity
) => {
    try {
        const componentNodes = getRunningExpressApp().nodesPool.componentNodes
        const { entity } = await validateResolvedDocumentVectorComponents(
            appDataSource,
            componentNodes,
            data.storeId,
            data,
            workspaceId,
            requireCoreComponents,
            operationRevision
        )

        const previousEmbeddingConfig = entity.embeddingConfig
        const previousVectorStoreConfig = entity.vectorStoreConfig
        const previousRecordManagerConfig = entity.recordManagerConfig

        if (data.embeddingName) {
            entity.embeddingConfig = JSON.stringify({
                config: data.embeddingConfig,
                name: data.embeddingName
            })
        } else if (entity.embeddingConfig && !data.embeddingName && !data.embeddingConfig) {
            data.embeddingConfig = JSON.parse(entity.embeddingConfig)?.config
            data.embeddingName = JSON.parse(entity.embeddingConfig)?.name
            if (isStrictSave) entity.embeddingConfig = null
        } else if (!data.embeddingName && !data.embeddingConfig) {
            entity.embeddingConfig = null
        }

        if (data.vectorStoreName) {
            entity.vectorStoreConfig = JSON.stringify({
                config: data.vectorStoreConfig,
                name: data.vectorStoreName
            })
        } else if (entity.vectorStoreConfig && !data.vectorStoreName && !data.vectorStoreConfig) {
            data.vectorStoreConfig = JSON.parse(entity.vectorStoreConfig)?.config
            data.vectorStoreName = JSON.parse(entity.vectorStoreConfig)?.name
            if (isStrictSave) entity.vectorStoreConfig = null
        } else if (!data.vectorStoreName && !data.vectorStoreConfig) {
            entity.vectorStoreConfig = null
        }

        if (data.recordManagerName) {
            entity.recordManagerConfig = JSON.stringify({
                config: data.recordManagerConfig,
                name: data.recordManagerName
            })
        } else if (entity.recordManagerConfig && !data.recordManagerName && !data.recordManagerConfig) {
            data.recordManagerConfig = JSON.parse(entity.recordManagerConfig)?.config
            data.recordManagerName = JSON.parse(entity.recordManagerConfig)?.name
            if (isStrictSave) entity.recordManagerConfig = null
        } else if (!data.recordManagerName && !data.recordManagerConfig) {
            entity.recordManagerConfig = null
        }

        const embeddingConfigurationChanged = !arePersistedComponentConfigsEquivalent(previousEmbeddingConfig, entity.embeddingConfig)
        const vectorStoreConfigurationChanged = !arePersistedComponentConfigsEquivalent(previousVectorStoreConfig, entity.vectorStoreConfig)
        const recordManagerConfigurationChanged = !arePersistedComponentConfigsEquivalent(
            previousRecordManagerConfig,
            entity.recordManagerConfig
        )
        const vectorConfigurationChanged =
            embeddingConfigurationChanged || vectorStoreConfigurationChanged || recordManagerConfigurationChanged
        if (!embeddingConfigurationChanged) entity.embeddingConfig = previousEmbeddingConfig
        if (!vectorStoreConfigurationChanged) entity.vectorStoreConfig = previousVectorStoreConfig
        if (!recordManagerConfigurationChanged) entity.recordManagerConfig = previousRecordManagerConfig
        if (!vectorConfigurationChanged) return entity

        entity.status = DocumentStoreStatus.STALE
        const updatedEntity = await updateExistingDocumentStore(
            appDataSource.getRepository(DocumentStore),
            entity,
            {
                embeddingConfig: entity.embeddingConfig,
                vectorStoreConfig: entity.vectorStoreConfig,
                recordManagerConfig: entity.recordManagerConfig,
                status: entity.status
            },
            'Document store vector configuration changed concurrently'
        )
        advanceDocumentStoreOperationRevision(operationRevision, updatedEntity)
        return updatedEntity
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to save document store vector configuration')
    }
}

const SAFE_PROVIDER_MAX_DEPTH = 8
const SAFE_PROVIDER_MAX_NODES = 4096
const SAFE_PROVIDER_MAX_STRING_CHARS = 1024 * 1024
const SAFE_PROVIDER_MAX_CONTAINER_ENTRIES = 512
const SAFE_PROVIDER_MAX_DOCUMENTS = 1000
const SAFE_PROVIDER_MAX_QUERY_DOCUMENTS = 100
const SAFE_PROVIDER_MAX_KEY_LENGTH = 256

interface SafeProviderCloneBudget {
    nodesRemaining: number
    stringCharsRemaining: number
}

const createSafeProviderCloneBudget = (): SafeProviderCloneBudget => ({
    nodesRemaining: SAFE_PROVIDER_MAX_NODES,
    stringCharsRemaining: SAFE_PROVIDER_MAX_STRING_CHARS
})

const getOwnDataDescriptor = (source: unknown, key: PropertyKey): PropertyDescriptor | undefined => {
    if ((typeof source !== 'object' && typeof source !== 'function') || source === null) return undefined
    try {
        const descriptor = Object.getOwnPropertyDescriptor(source, key)
        return descriptor && 'value' in descriptor ? descriptor : undefined
    } catch {
        return undefined
    }
}

const isSafePlainProviderObject = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    try {
        const prototype = Object.getPrototypeOf(value)
        return prototype === Object.prototype || prototype === null
    } catch {
        return false
    }
}

const cloneSafeProviderValue = (value: unknown, budget: SafeProviderCloneBudget, depth: number, ancestors: WeakSet<object>): unknown => {
    if (budget.nodesRemaining <= 0 || depth > SAFE_PROVIDER_MAX_DEPTH) return undefined
    budget.nodesRemaining -= 1

    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value === 'string') {
        if (budget.stringCharsRemaining <= 0) return ''
        const safeValue = value.slice(0, budget.stringCharsRemaining)
        budget.stringCharsRemaining -= safeValue.length
        return safeValue
    }
    if (typeof value !== 'object' || value === null) return undefined
    if (ancestors.has(value)) return undefined

    if (Array.isArray(value)) {
        const lengthDescriptor = getOwnDataDescriptor(value, 'length')
        const length = lengthDescriptor?.value
        if (!Number.isSafeInteger(length) || length < 0) return []
        const result: unknown[] = []
        ancestors.add(value)
        const limit = Math.min(length, SAFE_PROVIDER_MAX_CONTAINER_ENTRIES)
        for (let index = 0; index < limit && budget.nodesRemaining > 0; index += 1) {
            const descriptor = getOwnDataDescriptor(value, String(index))
            const cloned = descriptor ? cloneSafeProviderValue(descriptor.value, budget, depth + 1, ancestors) : undefined
            result.push(cloned === undefined ? null : cloned)
        }
        ancestors.delete(value)
        return result
    }

    if (!isSafePlainProviderObject(value)) return undefined
    let keys: string[]
    try {
        keys = Object.getOwnPropertyNames(value)
    } catch {
        return undefined
    }
    if (keys.length > SAFE_PROVIDER_MAX_CONTAINER_ENTRIES) return {}
    const result: Record<string, unknown> = {}
    ancestors.add(value)
    let acceptedEntries = 0
    for (const key of keys) {
        if (acceptedEntries >= SAFE_PROVIDER_MAX_CONTAINER_ENTRIES || budget.nodesRemaining <= 0) break
        if (key.length > SAFE_PROVIDER_MAX_KEY_LENGTH || key === '__proto__' || key === 'prototype' || key === 'constructor') {
            continue
        }
        const descriptor = getOwnDataDescriptor(value, key)
        if (!descriptor?.enumerable) continue
        const cloned = cloneSafeProviderValue(descriptor.value, budget, depth + 1, ancestors)
        if (cloned === undefined) continue
        Object.defineProperty(result, key, { value: cloned, enumerable: true, configurable: true, writable: true })
        acceptedEntries += 1
    }
    ancestors.delete(value)
    return result
}

const createSafeVectorStoreStats = (value: unknown): Record<string, number> => {
    const stats: Record<string, number> = {}
    for (const field of ['numAdded', 'numUpdated', 'numSkipped', 'numDeleted'] as const) {
        const descriptor = getOwnDataDescriptor(value, field)
        const count = descriptor?.value
        if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) stats[field] = count
    }
    return stats
}

export const createSafeVectorStoreResult = (indexResult: unknown): ICommonObject => {
    const fallback = { result: 'Successfully Upserted' }
    try {
        if ((typeof indexResult !== 'object' && typeof indexResult !== 'function') || indexResult === null) return fallback
        const safeResult: ICommonObject = createSafeVectorStoreStats(indexResult)

        const addedDocsDescriptor = getOwnDataDescriptor(indexResult, 'addedDocs')
        if (addedDocsDescriptor && Array.isArray(addedDocsDescriptor.value)) {
            const documents = addedDocsDescriptor.value
            const lengthDescriptor = getOwnDataDescriptor(documents, 'length')
            const length = lengthDescriptor?.value
            const safeDocuments: Array<{ pageContent: string; metadata: Record<string, unknown> }> = []
            const budget = createSafeProviderCloneBudget()
            if (Number.isSafeInteger(length) && length >= 0) {
                const limit = Math.min(length, SAFE_PROVIDER_MAX_DOCUMENTS)
                for (let index = 0; index < limit && budget.nodesRemaining > 0; index += 1) {
                    const documentDescriptor = getOwnDataDescriptor(documents, String(index))
                    const document = documentDescriptor?.value
                    if ((typeof document !== 'object' && typeof document !== 'function') || document === null) continue
                    const pageContentDescriptor = getOwnDataDescriptor(document, 'pageContent')
                    const metadataDescriptor = getOwnDataDescriptor(document, 'metadata')
                    const pageContent = pageContentDescriptor
                        ? cloneSafeProviderValue(pageContentDescriptor.value, budget, 0, new WeakSet())
                        : undefined
                    const metadata = metadataDescriptor
                        ? cloneSafeProviderValue(metadataDescriptor.value, budget, 0, new WeakSet())
                        : undefined
                    safeDocuments.push({
                        pageContent: typeof pageContent === 'string' ? pageContent : '',
                        metadata: isSafePlainProviderObject(metadata) ? metadata : {}
                    })
                }
            }
            safeResult.addedDocs = safeDocuments
        }
        if (Object.keys(safeResult).length === 0) return fallback
        return safeResult
    } catch {
        return fallback
    }
}

export const createSafeVectorQueryDocuments = (
    providerResults: unknown
): Array<{ pageContent: string; metadata: Record<string, unknown> }> => {
    const safeDocuments: Array<{ pageContent: string; metadata: Record<string, unknown> }> = []
    try {
        if (!Array.isArray(providerResults)) return safeDocuments
        const lengthDescriptor = getOwnDataDescriptor(providerResults, 'length')
        const length = lengthDescriptor?.value
        if (!Number.isSafeInteger(length) || length < 0) return safeDocuments

        const budget = createSafeProviderCloneBudget()
        const limit = Math.min(length, SAFE_PROVIDER_MAX_QUERY_DOCUMENTS)
        for (let index = 0; index < limit && budget.nodesRemaining > 0; index += 1) {
            const documentDescriptor = getOwnDataDescriptor(providerResults, String(index))
            const document = documentDescriptor?.value
            if ((typeof document !== 'object' && typeof document !== 'function') || document === null) continue

            const pageContentDescriptor = getOwnDataDescriptor(document, 'pageContent')
            const metadataDescriptor = getOwnDataDescriptor(document, 'metadata')
            const pageContent = pageContentDescriptor
                ? cloneSafeProviderValue(pageContentDescriptor.value, budget, 0, new WeakSet())
                : undefined
            if (typeof pageContent !== 'string') continue
            const metadata = metadataDescriptor ? cloneSafeProviderValue(metadataDescriptor.value, budget, 0, new WeakSet()) : undefined
            safeDocuments.push({
                pageContent,
                metadata: isSafePlainProviderObject(metadata) ? metadata : {}
            })
        }
    } catch {
        return safeDocuments
    }
    return safeDocuments
}

/**
 * Inserts documents from document store into the configured vector store.
 *
 * Process:
 * 1. Saves vector store configuration (embedding, vector store, record manager)
 * 2. Sets document store status to UPSERTING
 * 3. Performs the actual vector store upsert operation
 * 4. Updates status to UPSERTED upon completion
 */
export const insertIntoVectorStore = async (
    { appDataSource, componentNodes, telemetry, data, isStrictSave, orgId, workspaceId, operationIdentity }: IExecuteVectorStoreInsert,
    onProviderUpsertAttempt?: () => void
): Promise<ICommonObject> => {
    try {
        // Step 1: Save configuration based on isStrictSave mode
        const entity = await saveVectorStoreConfig(appDataSource, data, isStrictSave, workspaceId, true, operationIdentity)

        // Step 2: Mark as UPSERTING before starting the operation
        await updateExistingDocumentStore(
            appDataSource.getRepository(DocumentStore),
            entity,
            { status: DocumentStoreStatus.UPSERTING },
            'Document store vector state changed concurrently'
        )
        advanceDocumentStoreOperationRevision(operationIdentity, entity)

        // Step 3: Perform the actual vector store upsert
        // Note: Configuration already saved above, worker thread just retrieves and uses it
        const indexResult = await _insertIntoVectorStoreWorkerThread(
            appDataSource,
            componentNodes,
            telemetry,
            data,
            orgId,
            workspaceId,
            onProviderUpsertAttempt,
            operationIdentity
        )
        return indexResult
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to insert document store vectors')
    }
}

const insertIntoVectorStoreMiddleware = async (
    data: ICommonObject,
    isStrictSave = true,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    try {
        const appServer = getRunningExpressApp()
        const appDataSource = appServer.AppDataSource
        const componentNodes = appServer.nodesPool.componentNodes
        const telemetry = appServer.telemetry
        await validateResolvedDocumentVectorComponents(
            appDataSource,
            componentNodes,
            data.storeId,
            data,
            workspaceId,
            true,
            operationIdentity
        )

        const executeData: IExecuteVectorStoreInsert = {
            appDataSource,
            componentNodes,
            telemetry,
            data,
            isStrictSave,
            isVectorStoreInsert: true,
            orgId,
            workspaceId,
            subscriptionId,
            usageCacheManager,
            operationIdentity
        }

        if (process.env.MODE === MODE.QUEUE) {
            const upsertQueue = appServer.queueManager.getQueue('upsert')
            const job = await upsertQueue.addJob(omit(executeData, OMIT_QUEUE_JOB_DATA))
            logger.debug(`[server]: [${orgId}]: Job added to queue: ${job.id}`)

            const queueEvents = upsertQueue.getQueueEvents()
            const result = await waitForDocumentStoreQueueResult<any>(job, queueEvents)

            if (!result) {
                throw new Error('Job execution failed')
            }
            return result
        } else {
            return await insertIntoVectorStore(executeData)
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store vector insertion failed')
    }
}

const _insertIntoVectorStoreWorkerThread = async (
    appDataSource: DataSource,
    componentNodes: IComponentNodes,
    telemetry: Telemetry,
    data: ICommonObject,
    orgId: string,
    workspaceId: string,
    onProviderUpsertAttempt?: () => void,
    operationRevision?: DocumentStoreOperationIdentity
) => {
    try {
        let upsertHistory: Record<string, any> = {}
        const chatflowid = data.storeId // fake chatflowid because this is not tied to any chatflow

        const options: ICommonObject = {
            chatflowid,
            appDataSource,
            databaseEntities,
            workspaceId,
            orgId,
            logger,
            skipVariables: true,
            refreshOAuth2Credential: createWorkspaceOAuth2RefreshCapability(workspaceId)
        }

        const { entity, resolved } = await validateResolvedDocumentVectorComponents(
            appDataSource,
            componentNodes,
            data.storeId,
            data,
            workspaceId,
            true,
            operationRevision
        )
        Object.assign(data, resolved)

        let recordManagerObj = undefined

        // Get Record Manager Instance
        if (data.recordManagerName && data.recordManagerConfig) {
            recordManagerObj = await _createRecordManagerObject(componentNodes, data, options, upsertHistory)
        }

        // Get Embeddings Instance
        const embeddingObj = await _createEmbeddingsObject(componentNodes, data, options, upsertHistory)

        // Get Vector Store Node Data
        const vStoreNodeData = _createVectorStoreNodeData(componentNodes, data, embeddingObj, recordManagerObj)

        // Prepare docs for upserting
        const filterOptions: ICommonObject = {
            storeId: data.storeId
        }
        if (data.docId) {
            filterOptions['docId'] = data.docId
        }
        const chunks = await appDataSource.getRepository(DocumentStoreFileChunk).find({
            where: filterOptions
        })
        const docs: Document[] = chunks.map((chunk: DocumentStoreFileChunk) => {
            return new Document({
                pageContent: chunk.pageContent,
                metadata: {
                    ...JSON.parse(chunk.metadata),
                    docId: chunk.docId
                }
            })
        })
        vStoreNodeData.inputs.document = docs

        onProviderUpsertAttempt?.()
        // Vector-store initialization may create or connect external collections,
        // so recovery semantics start before node initialization, not only upsert.
        const vectorStoreObj = await _createVectorStoreObject(componentNodes, data, vStoreNodeData, upsertHistory)
        const indexResult = await vectorStoreObj.vectorStoreMethods.upsert(vStoreNodeData, options)

        // Build the history row now, but commit it only with the parent CAS.
        let upsertHistoryItem: UpsertHistory | undefined
        if (indexResult) {
            const result = cloneDeep(upsertHistory)
            result['flowData'] = JSON.stringify(result['flowData'])
            result['result'] = JSON.stringify(createSafeVectorStoreStats(indexResult))
            result.chatflowid = chatflowid
            const newUpsertHistory = new UpsertHistory()
            Object.assign(newUpsertHistory, result)
            upsertHistoryItem = appDataSource.getRepository(UpsertHistory).create(newUpsertHistory)
        }

        try {
            const telemetryResultDescriptor = getOwnDataDescriptor(indexResult, 'result')
            const telemetryFlowGraph = telemetryResultDescriptor ? createSafeVectorStoreStats(telemetryResultDescriptor.value) : {}
            await telemetry.sendTelemetry(
                'vector_upserted',
                {
                    version: await getAppVersion(),
                    chatlowId: chatflowid,
                    type: ChatType.INTERNAL,
                    flowGraph: telemetryFlowGraph
                },
                orgId
            )
        } catch {
            logger.warn('document_store_vector_telemetry_failed', { failedCount: 1 })
        }

        await appDataSource.transaction(async (transactionManager) => {
            if (upsertHistoryItem) {
                await transactionManager.getRepository(UpsertHistory).save(upsertHistoryItem)
            }
            await updateExistingDocumentStore(
                transactionManager.getRepository(DocumentStore),
                entity,
                { status: DocumentStoreStatus.UPSERTED },
                'Document store vector state changed concurrently'
            )
        })
        advanceDocumentStoreOperationRevision(operationRevision, entity)

        return {
            ...createSafeVectorStoreResult(indexResult),
            versionToken: createDocumentStoreVersionToken(entity)
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        logger.error('document_store_vector_insertion_failed', { failedCount: 1 })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store vector insertion failed')
    }
}

// Get all component nodes - Embeddings
const getEmbeddingProviders = async () => {
    try {
        const dbResponse = await nodesService.getAllNodesForCategory('Embeddings')
        return dbResponse.filter((node) => !node.tags?.includes('LlamaIndex'))
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.getEmbeddingProviders - ${getErrorMessage(error)}`
        )
    }
}

// Get all component nodes - Vector Stores
const getVectorStoreProviders = async () => {
    try {
        const dbResponse = await nodesService.getAllNodesForCategory('Vector Stores')
        return dbResponse.filter(
            (node) => !node.tags?.includes('LlamaIndex') && node.name !== 'documentStoreVS' && node.name !== 'memoryVectorStore'
        )
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.getVectorStoreProviders - ${getErrorMessage(error)}`
        )
    }
}
// Get all component nodes - Vector Stores
const getRecordManagerProviders = async () => {
    try {
        const dbResponse = await nodesService.getAllNodesForCategory('Record Manager')
        return dbResponse.filter((node) => !node.tags?.includes('LlamaIndex'))
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: documentStoreServices.getRecordManagerProviders - ${getErrorMessage(error)}`
        )
    }
}

const queryVectorStore = async (data: ICommonObject, workspaceId: string) => {
    try {
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store query is not authorized')
        const appServer = getRunningExpressApp()
        const componentNodes = appServer.nodesPool.componentNodes

        const entity = await appServer.AppDataSource.getRepository(DocumentStore).findOneBy({
            id: data.storeId,
            workspaceId
        })
        if (!entity) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
        }
        if (entity.status !== DocumentStoreStatus.UPSERTED) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store vector index is not available')
        }
        if (typeof data.query !== 'string' || !data.query.trim() || data.query.length > 10_000) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store query')
        }
        const options: ICommonObject = {
            chatflowid: uuidv4(),
            appDataSource: appServer.AppDataSource,
            databaseEntities,
            workspaceId,
            skipVariables: true,
            logger,
            refreshOAuth2Credential: createWorkspaceOAuth2RefreshCapability(workspaceId)
        }

        if (!entity.embeddingConfig) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Embedding for ${data.storeId} is not configured`)
        }

        if (!entity.vectorStoreConfig) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Vector Store for ${data.storeId} is not configured`)
        }

        const embeddingConfig = parsePersistedComponentConfig(entity.embeddingConfig)
        const vsConfig = parsePersistedComponentConfig(entity.vectorStoreConfig)
        const retrievalOverrides = parseRetrievalOverrides(data.inputs, vsConfig.config)
        const scopedQueryData: ICommonObject = {
            storeId: entity.id,
            embeddingName: embeddingConfig.name,
            embeddingConfig: embeddingConfig.config,
            vectorStoreName: vsConfig.name,
            vectorStoreConfig: { ...vsConfig.config, ...retrievalOverrides }
        }
        await validateDocumentVectorComponents(componentNodes, scopedQueryData, workspaceId, true)
        const embeddingObj = await _createEmbeddingsObject(componentNodes, scopedQueryData, options)

        const vStoreNodeData = _createVectorStoreNodeData(componentNodes, scopedQueryData, embeddingObj, undefined)

        // Get Vector Store Instance
        const vectorStoreObj = await _createVectorStoreObject(componentNodes, scopedQueryData, vStoreNodeData)
        const retriever = await vectorStoreObj.init(vStoreNodeData, '', options)
        if (!retriever) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Failed to create retriever`)
        }
        const startMillis = Date.now()
        const results = await retriever.invoke(data.query.trim(), undefined)
        if (!Array.isArray(results)) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Failed to retrieve results`)
        }
        const endMillis = Date.now()
        const timeTaken = endMillis - startMillis
        const docs = createSafeVectorQueryDocuments(results).map((document) => ({ ...document, id: uuidv4(), chunkNo: -1 }))
        // query our document store chunk with the storeId and pageContent
        for (const doc of docs) {
            const documentStoreChunk = await appServer.AppDataSource.getRepository(DocumentStoreFileChunk).findOneBy({
                storeId: entity.id,
                pageContent: doc.pageContent
            })
            if (documentStoreChunk) {
                doc.id = documentStoreChunk.id
                doc.chunkNo = documentStoreChunk.chunkNo
            } else {
                // this should not happen, only possible if the vector store has more content
                // than our document store
                doc.id = uuidv4()
                doc.chunkNo = -1
            }
        }

        return {
            timeTaken: timeTaken,
            docs: docs
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store query failed')
    }
}

const _createEmbeddingsObject = async (
    componentNodes: IComponentNodes,
    data: ICommonObject,
    options: ICommonObject,
    upsertHistory?: Record<string, any>
): Promise<any> => {
    // prepare embedding node data
    const embeddingComponent = resolveSafeDocumentStoreComponent(componentNodes, data.embeddingName, data.embeddingConfig, 'Embeddings')
    const embeddingNodeData: any = {
        inputs: { ...data.embeddingConfig },
        outputs: { output: 'document' },
        id: `${embeddingComponent.name}_0`,
        label: embeddingComponent.label,
        name: embeddingComponent.name,
        category: embeddingComponent.category,
        inputParams: embeddingComponent.inputs || []
    }
    if (data.embeddingConfig.credential) {
        embeddingNodeData.credential = data.embeddingConfig.credential
    }

    // save to upsert history
    if (upsertHistory) upsertHistory['flowData'] = saveUpsertFlowData(embeddingNodeData, upsertHistory)

    // init embedding object
    const embeddingNodeInstanceFilePath = embeddingComponent.filePath as string
    const embeddingNodeModule = await import(embeddingNodeInstanceFilePath)
    const embeddingNodeInstance = new embeddingNodeModule.nodeClass()
    const embeddingObj = await embeddingNodeInstance.init(embeddingNodeData, '', { ...options, skipVariables: true })
    if (!embeddingObj) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Failed to create EmbeddingObj`)
    }
    return embeddingObj
}

const _createRecordManagerObject = async (
    componentNodes: IComponentNodes,
    data: ICommonObject,
    options: ICommonObject,
    upsertHistory?: Record<string, any>
) => {
    // prepare record manager node data
    const recordManagerComponent = resolveSafeDocumentStoreComponent(
        componentNodes,
        data.recordManagerName,
        data.recordManagerConfig,
        'Record Manager'
    )
    const rmNodeData: any = {
        inputs: { ...data.recordManagerConfig },
        id: `${recordManagerComponent.name}_0`,
        inputParams: recordManagerComponent.inputs,
        label: recordManagerComponent.label,
        name: recordManagerComponent.name,
        category: recordManagerComponent.category
    }
    if (data.recordManagerConfig.credential) {
        rmNodeData.credential = data.recordManagerConfig.credential
    }

    // save to upsert history
    if (upsertHistory) upsertHistory['flowData'] = saveUpsertFlowData(rmNodeData, upsertHistory)

    // init record manager object
    const rmNodeInstanceFilePath = recordManagerComponent.filePath as string
    const rmNodeModule = await import(rmNodeInstanceFilePath)
    const rmNodeInstance = new rmNodeModule.nodeClass()
    const recordManagerObj = await rmNodeInstance.init(rmNodeData, '', { ...options, skipVariables: true })
    if (!recordManagerObj) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Failed to create RecordManager obj`)
    }
    return recordManagerObj
}

const _createVectorStoreNodeData = (componentNodes: IComponentNodes, data: ICommonObject, embeddingObj: any, recordManagerObj?: any) => {
    const vectorStoreComponent = resolveSafeDocumentStoreComponent(
        componentNodes,
        data.vectorStoreName,
        data.vectorStoreConfig,
        'Vector Stores'
    )
    const vStoreNodeData: any = {
        id: `${vectorStoreComponent.name}_0`,
        inputs: { ...data.vectorStoreConfig },
        outputs: { output: 'retriever' },
        label: vectorStoreComponent.label,
        name: vectorStoreComponent.name,
        category: vectorStoreComponent.category
    }
    if (data.vectorStoreConfig.credential) {
        vStoreNodeData.credential = data.vectorStoreConfig.credential
    }

    if (embeddingObj) {
        vStoreNodeData.inputs.embeddings = embeddingObj
    }

    if (recordManagerObj) {
        vStoreNodeData.inputs.recordManager = recordManagerObj
    }

    // Get all input params except the ones that are anchor points to avoid JSON stringify circular error
    const filterInputParams = ['document', 'embeddings', 'recordManager']
    const inputParams = vectorStoreComponent.inputs?.filter((input: any) => !filterInputParams.includes(input.name))
    vStoreNodeData.inputParams = inputParams
    return vStoreNodeData
}

const _createVectorStoreObject = async (
    componentNodes: IComponentNodes,
    data: ICommonObject,
    vStoreNodeData: INodeData,
    upsertHistory?: Record<string, any>
) => {
    const vectorStoreComponent = resolveSafeDocumentStoreComponent(
        componentNodes,
        data.vectorStoreName,
        data.vectorStoreConfig,
        'Vector Stores'
    )
    const vStoreNodeInstanceFilePath = vectorStoreComponent.filePath as string
    const vStoreNodeModule = await import(vStoreNodeInstanceFilePath)
    const vStoreNodeInstance = new vStoreNodeModule.nodeClass()
    if (upsertHistory) upsertHistory['flowData'] = saveUpsertFlowData(vStoreNodeData, upsertHistory)
    return vStoreNodeInstance
}

const parseUpsertComponentSelection = (value: unknown): ICommonObject => {
    if (value === undefined || value === null || value === '') return {}
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value)
        } catch {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
        }
    }
    if (!isPlainRecord(parsed) || Object.keys(parsed).some((key) => key !== 'name' && key !== 'config')) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
    }
    if (parsed.config !== undefined && !isPlainRecord(parsed.config)) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store component selection')
    }
    return parsed
}

const isCreateNewDocumentStore = (value: unknown): boolean => value === true || value === 'true'

const validateDocStoreUpsertComponents = async (
    appDataSource: DataSource,
    componentNodes: IComponentNodes,
    storeId: string,
    data: IDocumentStoreUpsertData,
    workspaceId: string,
    operationIdentity?: DocumentStoreOperationIdentity
): Promise<DocumentStore | null> => {
    const createNewDocStore = isCreateNewDocumentStore(data.createNewDocStore)
    let validatedEntity: DocumentStore | null = null
    let persistedLoader: ICommonObject = {}
    let persistedEmbedding: ICommonObject = {}
    let persistedVectorStore: ICommonObject = {}
    let persistedRecordManager: ICommonObject = {}

    if (!createNewDocStore) {
        validatedEntity = await appDataSource.getRepository(DocumentStore).findOneBy({ id: storeId, workspaceId })
        if (!validatedEntity) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
        assertDocumentStoreOperationRevision(validatedEntity, operationIdentity, 'Document store changed concurrently')
        persistedEmbedding = parsePersistedComponentConfig(validatedEntity.embeddingConfig)
        persistedVectorStore = parsePersistedComponentConfig(validatedEntity.vectorStoreConfig)
        persistedRecordManager = parsePersistedComponentConfig(validatedEntity.recordManagerConfig)
        if (data.docId) {
            const loaders = JSON.parse(validatedEntity.loaders)
            if (!Array.isArray(loaders))
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store loader configuration')
            persistedLoader = loaders.find((loader: IDocumentStoreLoader) => loader.id === data.docId) || {}
            if (!persistedLoader.id) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store loader not found')
        }
    }

    const newLoader = parseUpsertComponentSelection(data.loader)
    const newSplitter = parseUpsertComponentSelection(data.splitter)
    const newEmbedding = parseUpsertComponentSelection(data.embedding)
    const newVectorStore = parseUpsertComponentSelection(data.vectorStore)
    const newRecordManager = parseUpsertComponentSelection(data.recordManager)
    const processingData = {
        loaderId: newLoader.name || persistedLoader.loaderId,
        loaderConfig: { ...(persistedLoader.loaderConfig || {}), ...(newLoader.config || {}) },
        splitterId: newSplitter.name || persistedLoader.splitterId,
        splitterConfig: { ...(persistedLoader.splitterConfig || {}), ...(newSplitter.config || {}) },
        credential: persistedLoader.credential
    } as IDocumentStoreLoaderForPreview
    await validateDocumentProcessingComponents(componentNodes, processingData, workspaceId)

    await validateDocumentVectorComponents(
        componentNodes,
        {
            embeddingName: newEmbedding.name || persistedEmbedding.name,
            embeddingConfig: { ...(persistedEmbedding.config || {}), ...(newEmbedding.config || {}) },
            vectorStoreName: newVectorStore.name || persistedVectorStore.name,
            vectorStoreConfig: { ...(persistedVectorStore.config || {}), ...(newVectorStore.config || {}) },
            recordManagerName: newRecordManager.name || persistedRecordManager.name,
            recordManagerConfig: { ...(persistedRecordManager.config || {}), ...(newRecordManager.config || {}) }
        },
        workspaceId,
        true
    )
    return validatedEntity
}

const upsertDocStore = async (
    appDataSource: DataSource,
    componentNodes: IComponentNodes,
    telemetry: Telemetry,
    storeId: string,
    data: IDocumentStoreUpsertData,
    files: Express.Multer.File[] = [],
    isRefreshExisting = false,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager,
    operationRevision?: DocumentStoreOperationIdentity
) => {
    const validatedEntity = await validateDocStoreUpsertComponents(
        appDataSource,
        componentNodes,
        storeId,
        data,
        workspaceId,
        operationRevision
    )
    const docId = data.docId
    let metadata = {}
    if (data.metadata) {
        try {
            metadata = typeof data.metadata === 'string' ? JSON.parse(data.metadata) : data.metadata
        } catch (error) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Error: Invalid metadata`)
        }
    }
    const replaceExisting =
        typeof data.replaceExisting === 'string' ? (data.replaceExisting as string).toLowerCase() === 'true' : data.replaceExisting ?? false
    const createNewDocStore =
        typeof data.createNewDocStore === 'string'
            ? (data.createNewDocStore as string).toLowerCase() === 'true'
            : data.createNewDocStore ?? false
    const newLoader = typeof data.loader === 'string' ? JSON.parse(data.loader) : data.loader
    const newSplitter = typeof data.splitter === 'string' ? JSON.parse(data.splitter) : data.splitter
    const newVectorStore = typeof data.vectorStore === 'string' ? JSON.parse(data.vectorStore) : data.vectorStore
    const newEmbedding = typeof data.embedding === 'string' ? JSON.parse(data.embedding) : data.embedding
    const newRecordManager = typeof data.recordManager === 'string' ? JSON.parse(data.recordManager) : data.recordManager

    const getComponentLabelFromName = (nodeName: string) => {
        const component = Object.values(componentNodes).find((node) => node.name === nodeName)
        return component?.label || ''
    }

    let loaderName = ''
    let loaderId = ''
    let loaderConfig: ICommonObject = {}

    let splitterName = ''
    let splitterId = ''
    let splitterConfig: ICommonObject = {}

    let vectorStoreName = ''
    let vectorStoreConfig: ICommonObject = {}

    let embeddingName = ''
    let embeddingConfig: ICommonObject = {}

    let recordManagerName = ''
    let recordManagerConfig: ICommonObject = {}

    // Step 1: Get existing loader
    if (docId) {
        if (!validatedEntity) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
        }

        const loaders = JSON.parse(validatedEntity.loaders)
        const loader = loaders.find((ldr: IDocumentStoreLoader) => ldr.id === docId)
        if (!loader) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Document loader ${docId} not found`)
        }

        // Loader
        loaderName = loader.loaderName
        loaderId = loader.loaderId
        loaderConfig = {
            ...loaderConfig,
            ...loader?.loaderConfig
        }

        // Splitter
        splitterName = loader.splitterName
        splitterId = loader.splitterId
        splitterConfig = {
            ...splitterConfig,
            ...loader?.splitterConfig
        }

        // Vector Store
        vectorStoreName = JSON.parse(validatedEntity.vectorStoreConfig || '{}')?.name
        vectorStoreConfig = JSON.parse(validatedEntity.vectorStoreConfig || '{}')?.config

        // Embedding
        embeddingName = JSON.parse(validatedEntity.embeddingConfig || '{}')?.name
        embeddingConfig = JSON.parse(validatedEntity.embeddingConfig || '{}')?.config

        // Record Manager
        recordManagerName = JSON.parse(validatedEntity.recordManagerConfig || '{}')?.name
        recordManagerConfig = JSON.parse(validatedEntity.recordManagerConfig || '{}')?.config
    }

    let createdDocumentStore: DocumentStore | undefined
    let providerSideEffectPossible = false
    try {
        if (createNewDocStore) {
            const docStoreBody = typeof data.docStore === 'string' ? JSON.parse(data.docStore) : data.docStore
            const newDocumentStore = docStoreBody ?? { name: `Document Store ${Date.now().toString()}` }
            const docStore = DocumentStoreDTO.toEntity(newDocumentStore)
            docStore.workspaceId = workspaceId // enforce trusted server-side value, never from user input
            const documentStore = appDataSource.getRepository(DocumentStore).create({
                ...getDocumentStoreMutablePatch(docStore),
                workspaceId,
                generationId: createDocumentStoreGenerationId()
            })
            const dbResponse = await appDataSource.getRepository(DocumentStore).save(documentStore)
            storeId = dbResponse.id
            createdDocumentStore = dbResponse
            operationRevision = createDocumentStoreOperationRevision(dbResponse)
        }

        // Step 2: Replace with new values
        loaderName = newLoader?.name ? getComponentLabelFromName(newLoader?.name) : loaderName
        loaderId = newLoader?.name || loaderId
        loaderConfig = {
            ...loaderConfig,
            ...newLoader?.config
        }

        // Override loaderName if it's provided directly in data
        if (data.loaderName) {
            loaderName = data.loaderName
        }

        splitterName = newSplitter?.name ? getComponentLabelFromName(newSplitter?.name) : splitterName
        splitterId = newSplitter?.name || splitterId
        splitterConfig = {
            ...splitterConfig,
            ...newSplitter?.config
        }

        vectorStoreName = newVectorStore?.name || vectorStoreName
        vectorStoreConfig = {
            ...vectorStoreConfig,
            ...newVectorStore?.config
        }

        embeddingName = newEmbedding?.name || embeddingName
        embeddingConfig = {
            ...embeddingConfig,
            ...newEmbedding?.config
        }

        recordManagerName = newRecordManager?.name || recordManagerName
        recordManagerConfig = {
            ...recordManagerConfig,
            ...newRecordManager?.config
        }

        // Step 3: Replace with files
        if (files.length) {
            const filesLoaderConfig: ICommonObject = {}
            for (const file of files) {
                const uploadPath = file.path ?? file.key
                if (typeof uploadPath !== 'string' || !uploadPath) {
                    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid document store upload')
                }
                const fileNames: string[] = []
                const fileBuffer = await getFileFromUpload(uploadPath)
                // Address file name with special characters: https://github.com/expressjs/multer/issues/1104
                file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')

                validateFileMimeTypeAndExtensionMatch(file.originalname, file.mimetype)
                await checkStorage(orgId, subscriptionId, usageCacheManager)
                const { totalSize } = await addArrayFilesToStorage(
                    file.mimetype,
                    fileBuffer,
                    file.originalname,
                    fileNames,
                    orgId,
                    DOCUMENT_STORE_BASE_FOLDER,
                    storeId
                )
                await updateStorageUsage(orgId, workspaceId, totalSize, usageCacheManager)

                const mimePrefix = 'data:' + file.mimetype + ';base64'
                const storagePath = mimePrefix + ',' + fileBuffer.toString('base64') + `,filename:${file.originalname}`
                const fileInputField = resolveDocumentStoreFileInputField(file.mimetype, file.originalname, loaderId)

                if (filesLoaderConfig[fileInputField]) {
                    const existingFileInputFieldArray = JSON.parse(filesLoaderConfig[fileInputField])
                    filesLoaderConfig[fileInputField] = JSON.stringify(existingFileInputFieldArray.concat([storagePath]))
                } else {
                    filesLoaderConfig[fileInputField] = JSON.stringify([storagePath])
                }
            }

            loaderConfig = {
                ...loaderConfig,
                ...filesLoaderConfig
            }
        }

        if (Object.keys(metadata).length > 0) {
            loaderConfig = {
                ...loaderConfig,
                metadata
            }
        }

        // Step 4: Verification for must have components
        if (!loaderName || !loaderId || !loaderConfig) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Loader not configured`)
        }

        if (!vectorStoreName || !vectorStoreConfig) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Vector store not configured`)
        }

        if (!embeddingName || !embeddingConfig) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Embedding not configured`)
        }

        // Step 5: Process & Upsert
        const processData: IDocumentStoreLoaderForPreview = {
            storeId,
            loaderId,
            loaderName,
            loaderConfig,
            splitterId,
            splitterName,
            splitterConfig
        }

        if (isRefreshExisting || replaceExisting) {
            processData.id = docId
        }

        try {
            if (!operationRevision) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store operation ownership is missing')
            }
            const newLoader = await saveProcessingLoader(appDataSource, processData, workspaceId, operationRevision)
            const result = await processLoader({
                appDataSource,
                componentNodes,
                data: processData,
                docLoaderId: newLoader.id || '',
                isProcessWithoutUpsert: false,
                telemetry,
                orgId,
                workspaceId,
                subscriptionId,
                usageCacheManager,
                operationIdentity: operationRevision
            })
            const newDocId = result.docId

            const insertData = {
                storeId,
                docId: newDocId,
                vectorStoreName,
                vectorStoreConfig,
                embeddingName,
                embeddingConfig,
                recordManagerName,
                recordManagerConfig
            }

            // Use isStrictSave: false to preserve existing configurations during upsert
            // This allows the operation to reuse existing embedding/vector store/record manager configs
            const res = await insertIntoVectorStore(
                {
                    appDataSource,
                    componentNodes,
                    telemetry,
                    data: insertData,
                    isStrictSave: false,
                    isVectorStoreInsert: true,
                    orgId,
                    workspaceId,
                    subscriptionId,
                    usageCacheManager,
                    operationIdentity: operationRevision
                },
                () => {
                    providerSideEffectPossible = true
                }
            )
            res.docId = newDocId

            return res
        } catch (error) {
            if (error instanceof InternalFlowiseError) throw error
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store upsert failed')
        }
    } catch (error) {
        if (createdDocumentStore) {
            await handleCreatedDocumentStoreFailure(
                appDataSource,
                orgId,
                workspaceId,
                {
                    id: createdDocumentStore.id,
                    workspaceId: createdDocumentStore.workspaceId,
                    generationId: createdDocumentStore.generationId,
                    revision: operationRevision?.revision ?? createdDocumentStore.revision
                },
                usageCacheManager,
                providerSideEffectPossible
            )
        }
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store upsert failed')
    }
}

export const executeDocStoreUpsert = async ({
    appDataSource,
    componentNodes,
    telemetry,
    storeId,
    totalItems,
    files = [],
    isRefreshAPI,
    orgId,
    workspaceId,
    subscriptionId,
    usageCacheManager,
    operationIdentity
}: IExecuteDocStoreUpsert) => {
    try {
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
        const createFlags = totalItems.map((item) => isCreateNewDocumentStore(item.createNewDocStore))
        if (isRefreshAPI && createFlags.some(Boolean)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Refresh cannot create a document store')
        }
        if (createFlags.some(Boolean) && totalItems.length !== 1) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Document store creation accepts one item')
        }
        if (!createFlags.some(Boolean)) {
            const scopedStore = await appDataSource.getRepository(DocumentStore).findOneBy({ id: storeId, workspaceId })
            if (!scopedStore) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
            assertDocumentStoreOperationRevision(scopedStore, operationIdentity, 'Document store changed concurrently')
        }
        for (const item of totalItems) {
            await validateDocStoreUpsertComponents(appDataSource, componentNodes, storeId, item, workspaceId, operationIdentity)
        }
        const results = []
        for (const item of totalItems) {
            const res = await upsertDocStore(
                appDataSource,
                componentNodes,
                telemetry,
                storeId,
                item,
                files,
                isRefreshAPI,
                orgId,
                workspaceId,
                subscriptionId,
                usageCacheManager,
                operationIdentity
            )
            results.push(res)
        }
        if (!isRefreshAPI) return results[0]
        const latestResult = results[results.length - 1]
        return {
            results,
            versionToken:
                latestResult?.versionToken ?? createDocumentStoreVersionTokenFromClaim(operationIdentity as DocumentStoreOperationIdentity)
        }
    } finally {
        await cleanupDocumentStoreUploads(files)
    }
}

const upsertDocStoreMiddleware = async (
    storeId: string,
    data: IDocumentStoreUpsertData,
    files: Express.Multer.File[] = [],
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager,
    operationIdentity?: DocumentStoreOperationIdentity
) => {
    const appServer = getRunningExpressApp()
    const componentNodes = appServer.nodesPool.componentNodes
    const appDataSource = appServer.AppDataSource
    const telemetry = appServer.telemetry
    let cleanupOwnedByExecution = false

    try {
        const createNewDocStore = isCreateNewDocumentStore(data.createNewDocStore)
        if (!createNewDocStore) {
            const entity = await getScopedDocumentStore(storeId, workspaceId)
            assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document store changed concurrently')
        }
        await validateDocStoreUpsertComponents(appDataSource, componentNodes, storeId, data, workspaceId, operationIdentity)
        const executeData: IExecuteDocStoreUpsert = {
            appDataSource,
            componentNodes,
            telemetry,
            storeId,
            totalItems: [data],
            files,
            isRefreshAPI: false,
            orgId,
            workspaceId,
            subscriptionId,
            usageCacheManager,
            operationIdentity
        }

        if (process.env.MODE === MODE.QUEUE) {
            const upsertQueue = appServer.queueManager.getQueue('upsert')
            const job = await upsertQueue.addJob(omit(executeData, OMIT_QUEUE_JOB_DATA))
            cleanupOwnedByExecution = true
            logger.debug(`[server]: [${orgId}]: Job added to queue: ${job.id}`)

            const queueEvents = upsertQueue.getQueueEvents()
            const result = await waitForDocumentStoreQueueResult<any>(job, queueEvents)

            if (!result) {
                throw new Error('Job execution failed')
            }
            return result
        } else {
            cleanupOwnedByExecution = true
            return await executeDocStoreUpsert(executeData)
        }
    } catch (error) {
        if (!cleanupOwnedByExecution) await cleanupDocumentStoreUploads(files)
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store upsert failed')
    }
}

const refreshDocStoreMiddleware = async (
    storeId: string,
    data: IDocumentStoreRefreshData,
    orgId: string,
    workspaceId: string,
    subscriptionId: string,
    usageCacheManager: UsageCacheManager,
    operationIdentity: DocumentStoreOperationIdentity
) => {
    const appServer = getRunningExpressApp()
    const componentNodes = appServer.nodesPool.componentNodes
    const appDataSource = appServer.AppDataSource
    const telemetry = appServer.telemetry

    try {
        const entity = await getScopedDocumentStore(storeId, workspaceId)
        assertDocumentStoreOperationRevision(entity, operationIdentity, 'Document store changed concurrently')
        let totalItems: IDocumentStoreUpsertData[] = []

        if (!data || !data.items || data.items.length === 0) {
            const loaders = JSON.parse(entity.loaders)
            totalItems = loaders.map((ldr: IDocumentStoreLoader) => {
                return {
                    docId: ldr.id
                }
            })
        } else {
            totalItems = data.items
        }
        if (totalItems.some((item) => isCreateNewDocumentStore(item.createNewDocStore))) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Refresh cannot create a document store')
        }
        for (const item of totalItems) {
            await validateDocStoreUpsertComponents(appDataSource, componentNodes, storeId, item, workspaceId, operationIdentity)
        }

        const executeData: IExecuteDocStoreUpsert = {
            appDataSource,
            componentNodes,
            telemetry,
            storeId,
            totalItems,
            files: [],
            isRefreshAPI: true,
            orgId,
            workspaceId,
            subscriptionId,
            usageCacheManager,
            operationIdentity
        }

        if (process.env.MODE === MODE.QUEUE) {
            const upsertQueue = appServer.queueManager.getQueue('upsert')
            const job = await upsertQueue.addJob(omit(executeData, OMIT_QUEUE_JOB_DATA))
            logger.debug(`[server]: [${orgId}]: Job added to queue: ${job.id}`)

            const queueEvents = upsertQueue.getQueueEvents()
            const result = await waitForDocumentStoreQueueResult<any>(job, queueEvents)

            if (!result) {
                throw new Error('Job execution failed')
            }
            return result
        } else {
            return await executeDocStoreUpsert(executeData)
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store refresh failed')
    }
}

const generateDocStoreToolDesc = async (
    docStoreId: string,
    selectedChatModel: ICommonObject,
    workspaceId: string
): Promise<ICommonObject> => {
    try {
        if (!workspaceId) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store tool description generation is not authorized')
        }
        const appServer = getRunningExpressApp()

        const documentStore = await appServer.AppDataSource.getRepository(DocumentStore).findOneBy({
            id: docStoreId,
            workspaceId
        })
        if (!documentStore) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
        }
        const safeChatModel = await resolveDocumentStoreChatModel(selectedChatModel, workspaceId)

        // get matching DocumentStoreFileChunk storeId with docStoreId, and only the first 4 chunks sorted by chunkNo
        const chunks = await appServer.AppDataSource.getRepository(DocumentStoreFileChunk).findBy({
            storeId: docStoreId
        })

        if (!chunks?.length) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `DocumentStore ${docStoreId} chunks not found`)
        }

        // sort the chunks by chunkNo
        chunks.sort((a, b) => a.chunkNo - b.chunkNo)

        // get the first 4 chunks
        const chunksPageContent = chunks
            .slice(0, 4)
            .map((chunk) => {
                return chunk.pageContent
            })
            .join('\n')

        const nodeModule = await import(safeChatModel.component.filePath as string)
        const newNodeInstance = new nodeModule.nodeClass()
        const options: ICommonObject = {
            appDataSource: appServer.AppDataSource,
            databaseEntities,
            workspaceId,
            skipVariables: true,
            logger,
            refreshOAuth2Credential: createWorkspaceOAuth2RefreshCapability(workspaceId)
        }
        const llmNodeInstance = await newNodeInstance.init(safeChatModel.nodeData, '', options)
        const response = await llmNodeInstance.invoke(
            DOCUMENTSTORE_TOOL_DESCRIPTION_PROMPT_GENERATOR.replace('{context}', chunksPageContent)
        )
        const content = extractResponseContent(response)
        return { content }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to generate document store tool description')
    }
}

export const findDocStoreAvailableConfigs = async (storeId: string, docId: string, workspaceId: string) => {
    // find the document store
    const appServer = getRunningExpressApp()
    if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
    const entity = await appServer.AppDataSource.getRepository(DocumentStore).findOneBy({ id: storeId, workspaceId })

    if (!entity) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
    }

    const loaders = JSON.parse(entity.loaders)
    const loader = loaders.find((ldr: IDocumentStoreLoader) => ldr.id === docId)
    if (!loader) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store loader not found')
    }

    const nodes = []
    const componentCredentials = appServer.nodesPool.componentCredentials

    const loaderName = loader.loaderId
    const loaderLabel = appServer.nodesPool.componentNodes[loaderName].label

    const loaderInputs =
        appServer.nodesPool.componentNodes[loaderName].inputs?.filter((input) => INPUT_PARAMS_TYPE.includes(input.type)) ?? []
    nodes.push({
        label: loaderLabel,
        nodeId: `${loaderName}_0`,
        inputParams: loaderInputs
    })

    const splitterName = loader.splitterId
    if (splitterName) {
        const splitterLabel = appServer.nodesPool.componentNodes[splitterName].label
        const splitterInputs =
            appServer.nodesPool.componentNodes[splitterName].inputs?.filter((input) => INPUT_PARAMS_TYPE.includes(input.type)) ?? []
        nodes.push({
            label: splitterLabel,
            nodeId: `${splitterName}_0`,
            inputParams: splitterInputs
        })
    }

    if (entity.vectorStoreConfig) {
        const vectorStoreName = JSON.parse(entity.vectorStoreConfig || '{}').name
        const vectorStoreLabel = appServer.nodesPool.componentNodes[vectorStoreName].label
        const vectorStoreInputs =
            appServer.nodesPool.componentNodes[vectorStoreName].inputs?.filter((input) => INPUT_PARAMS_TYPE.includes(input.type)) ?? []
        nodes.push({
            label: vectorStoreLabel,
            nodeId: `${vectorStoreName}_0`,
            inputParams: vectorStoreInputs
        })
    }

    if (entity.embeddingConfig) {
        const embeddingName = JSON.parse(entity.embeddingConfig || '{}').name
        const embeddingLabel = appServer.nodesPool.componentNodes[embeddingName].label
        const embeddingInputs =
            appServer.nodesPool.componentNodes[embeddingName].inputs?.filter((input) => INPUT_PARAMS_TYPE.includes(input.type)) ?? []
        nodes.push({
            label: embeddingLabel,
            nodeId: `${embeddingName}_0`,
            inputParams: embeddingInputs
        })
    }

    if (entity.recordManagerConfig) {
        const recordManagerName = JSON.parse(entity.recordManagerConfig || '{}').name
        const recordManagerLabel = appServer.nodesPool.componentNodes[recordManagerName].label
        const recordManagerInputs =
            appServer.nodesPool.componentNodes[recordManagerName].inputs?.filter((input) => INPUT_PARAMS_TYPE.includes(input.type)) ?? []
        nodes.push({
            label: recordManagerLabel,
            nodeId: `${recordManagerName}_0`,
            inputParams: recordManagerInputs
        })
    }

    const configs: IOverrideConfig[] = []
    for (const node of nodes) {
        const inputParams = node.inputParams
        for (const inputParam of inputParams) {
            let obj: IOverrideConfig
            if (inputParam.type === 'file') {
                obj = {
                    node: node.label,
                    nodeId: node.nodeId,
                    label: inputParam.label,
                    name: 'files',
                    type: inputParam.fileType ?? inputParam.type
                }
            } else if (inputParam.type === 'options') {
                obj = {
                    node: node.label,
                    nodeId: node.nodeId,
                    label: inputParam.label,
                    name: inputParam.name,
                    type: inputParam.options
                        ? inputParam.options
                              ?.map((option) => {
                                  return option.name
                              })
                              .join(', ')
                        : 'string'
                }
            } else if (inputParam.type === 'credential') {
                // get component credential inputs
                for (const name of inputParam.credentialNames ?? []) {
                    if (Object.prototype.hasOwnProperty.call(componentCredentials, name)) {
                        const inputs = componentCredentials[name]?.inputs ?? []
                        for (const input of inputs) {
                            obj = {
                                node: node.label,
                                nodeId: node.nodeId,
                                label: input.label,
                                name: input.name,
                                type: input.type === 'password' ? 'string' : input.type
                            }
                            configs.push(obj)
                        }
                    }
                }
                continue
            } else {
                obj = {
                    node: node.label,
                    nodeId: node.nodeId,
                    label: inputParam.label,
                    name: inputParam.name,
                    type: inputParam.type === 'password' ? 'string' : inputParam.type
                }
            }
            if (!configs.some((config) => JSON.stringify(config) === JSON.stringify(obj))) {
                configs.push(obj)
            }
        }
    }

    return configs
}

export default {
    updateDocumentStoreUsage,
    deleteDocumentStore,
    createDocumentStore,
    deleteLoaderFromDocumentStore,
    getAllDocumentStores,
    getAllDocumentFileChunksByDocumentStoreIds,
    getDocumentStoreById,
    getUsedChatflowNames,
    getDocumentStoreFileChunks,
    updateDocumentStore,
    previewChunksMiddleware,
    saveProcessingLoader,
    processLoaderMiddleware,
    deleteDocumentStoreFileChunk,
    editDocumentStoreFileChunk,
    getDocumentLoaders,
    insertIntoVectorStoreMiddleware,
    getEmbeddingProviders,
    getVectorStoreProviders,
    getRecordManagerProviders,
    saveVectorStoreConfig,
    queryVectorStore,
    deleteVectorStoreFromStore,
    updateVectorStoreConfigOnly,
    upsertDocStoreMiddleware,
    refreshDocStoreMiddleware,
    generateDocStoreToolDesc,
    findDocStoreAvailableConfigs
}
