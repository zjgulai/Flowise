import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import documentStoreService from '../../services/documentstore'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { DocumentStoreDTO } from '../../Interface'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { FLOWISE_COUNTER_STATUS, FLOWISE_METRIC_COUNTERS } from '../../Interface.Metrics'
import { getPageAndLimitParams } from '../../utils/pagination'
import { removeSpecificFileFromUpload } from 'flowise-components'
import logger from '../../utils/logger'
import {
    createDocumentStoreOperationIdentity,
    parseDocumentStoreIfMatch,
    type DocumentStoreOperationIdentity
} from '../../services/documentstore/documentStoreVersion'

const hasDocumentStorePermission = (req: Request, permission: string): boolean =>
    Boolean(req.user?.isOrganizationAdmin || req.user?.permissions?.includes(permission))

const getDocumentStoreOperationIdentity = (req: Request, storeId: string, workspaceId: string): DocumentStoreOperationIdentity =>
    createDocumentStoreOperationIdentity(storeId, workspaceId, parseDocumentStoreIfMatch(req.headers['if-match']))

const cleanupRejectedDocumentStoreUploads = async (files: Express.Multer.File[]): Promise<void> => {
    const uploadPaths = [
        ...new Set(
            files
                .map((file) => file.path ?? file.key)
                .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
        )
    ]
    const results = await Promise.allSettled(uploadPaths.map((filePath) => removeSpecificFileFromUpload(filePath)))
    const failedCount = results.filter((result) => result.status === 'rejected').length
    if (failedCount > 0) {
        logger.error('document_store_rejected_upload_cleanup_failed', { failedCount, totalCount: uploadPaths.length })
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Document store upload cleanup failed')
    }
}

const recordVectorStoreMetric = async (status: FLOWISE_COUNTER_STATUS): Promise<void> => {
    let failedCount = 0
    try {
        await Promise.resolve().then(() =>
            getRunningExpressApp().metricsProvider?.incrementCounter(FLOWISE_METRIC_COUNTERS.VECTORSTORE_UPSERT, { status })
        )
    } catch {
        failedCount = 1
    }
    if (failedCount > 0) {
        try {
            logger.error('document_store_vector_metric_failed', { failedCount, totalCount: 1, status })
        } catch {
            // Observability must never reverse or mask the document-store result.
        }
    }
}

const assertDocumentStoreUpsertPermission = async (req: Request, files: Express.Multer.File[], createNewDocStore = false) => {
    const permitted =
        hasDocumentStorePermission(req, 'documentStores:upsert-config') &&
        (!createNewDocStore || hasDocumentStorePermission(req, 'documentStores:create'))
    if (permitted) return
    throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
}

const createDocumentStore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.body === 'undefined') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - body not provided!`
            )
        }

        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }

        const body = req.body
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const docStore = DocumentStoreDTO.toEntity(body)
        docStore.workspaceId = workspaceId
        const apiResponse = await documentStoreService.createDocumentStore(docStore, orgId)
        return res.json(DocumentStoreDTO.fromEntity(apiResponse))
    } catch (error) {
        next(error)
    }
}

const getAllDocumentStores = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { page, limit } = getPageAndLimitParams(req)
        const search = typeof req.query?.search === 'string' ? req.query.search.trim() : undefined
        const orderBy =
            typeof req.query?.orderBy === 'string' && ['name', 'updatedDate'].includes(req.query.orderBy)
                ? (req.query.orderBy as 'name' | 'updatedDate')
                : undefined
        const order =
            typeof req.query?.order === 'string' && ['asc', 'desc'].includes(req.query.order)
                ? (req.query.order as 'asc' | 'desc')
                : undefined

        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.getAllDocumentStores - workspaceId not provided!`
            )
        }
        const apiResponse: any = await documentStoreService.getAllDocumentStores(workspaceId, page, limit, search, orderBy, order)
        if (apiResponse?.total >= 0) {
            return res.json({
                total: apiResponse.total,
                data: DocumentStoreDTO.fromEntities(apiResponse.data)
            })
        } else {
            return res.json(DocumentStoreDTO.fromEntities(apiResponse))
        }
    } catch (error) {
        next(error)
    }
}

const deleteLoaderFromDocumentStore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const storeId = req.params.id
        const loaderId = req.params.loaderId

        if (!storeId || !loaderId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.deleteLoaderFromDocumentStore - missing storeId or loaderId.`
            )
        }

        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, storeId, workspaceId)

        const apiResponse = await documentStoreService.deleteLoaderFromDocumentStore(
            storeId,
            loaderId,
            orgId,
            workspaceId,
            getRunningExpressApp().usageCacheManager,
            operationIdentity
        )
        return res.json(DocumentStoreDTO.fromEntity(apiResponse))
    } catch (error) {
        next(error)
    }
}

const getDocumentStoreById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.getDocumentStoreById - id not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.getDocumentStoreById - workspaceId not provided!`
            )
        }
        const apiResponse = await documentStoreService.getDocumentStoreById(req.params.id, workspaceId)
        if (apiResponse && apiResponse.whereUsed) {
            apiResponse.whereUsed = JSON.stringify(await documentStoreService.getUsedChatflowNames(apiResponse, workspaceId))
        }
        return res.json(DocumentStoreDTO.fromEntity(apiResponse))
    } catch (error) {
        next(error)
    }
}

const getDocumentStoreFileChunks = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.storeId === 'undefined' || req.params.storeId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.getDocumentStoreFileChunks - storeId not provided!`
            )
        }
        if (typeof req.params.fileId === 'undefined' || req.params.fileId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.getDocumentStoreFileChunks - fileId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.getDocumentStoreFileChunks - workspaceId not provided!`
            )
        }
        const appDataSource = getRunningExpressApp().AppDataSource
        const page = req.params.pageNo ? parseInt(req.params.pageNo) : 1
        const apiResponse = await documentStoreService.getDocumentStoreFileChunks(
            appDataSource,
            req.params.storeId,
            req.params.fileId,
            workspaceId,
            page
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteDocumentStoreFileChunk = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.storeId === 'undefined' || req.params.storeId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.deleteDocumentStoreFileChunk - storeId not provided!`
            )
        }
        if (typeof req.params.loaderId === 'undefined' || req.params.loaderId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.deleteDocumentStoreFileChunk - loaderId not provided!`
            )
        }
        if (typeof req.params.chunkId === 'undefined' || req.params.chunkId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.deleteDocumentStoreFileChunk - chunkId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.deleteDocumentStoreFileChunk - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, req.params.storeId, workspaceId)
        const apiResponse = await documentStoreService.deleteDocumentStoreFileChunk(
            req.params.storeId,
            req.params.loaderId,
            req.params.chunkId,
            workspaceId,
            operationIdentity
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const editDocumentStoreFileChunk = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.storeId === 'undefined' || req.params.storeId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.editDocumentStoreFileChunk - storeId not provided!`
            )
        }
        if (typeof req.params.loaderId === 'undefined' || req.params.loaderId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.editDocumentStoreFileChunk - loaderId not provided!`
            )
        }
        if (typeof req.params.chunkId === 'undefined' || req.params.chunkId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.editDocumentStoreFileChunk - chunkId not provided!`
            )
        }
        const body = req.body
        if (typeof body === 'undefined') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.editDocumentStoreFileChunk - body not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.editDocumentStoreFileChunk - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, req.params.storeId, workspaceId)
        const apiResponse = await documentStoreService.editDocumentStoreFileChunk(
            req.params.storeId,
            req.params.loaderId,
            req.params.chunkId,
            body.pageContent,
            body.metadata,
            workspaceId,
            operationIdentity
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const saveProcessingLoader = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const appServer = getRunningExpressApp()
        if (typeof req.body === 'undefined') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.saveProcessingLoader - body not provided!`
            )
        }
        const body = req.body
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.saveProcessingLoader - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, body.storeId, workspaceId)
        const apiResponse = await documentStoreService.saveProcessingLoader(appServer.AppDataSource, body, workspaceId, operationIdentity)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const processLoader = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.loaderId === 'undefined' || req.params.loaderId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.processLoader - loaderId not provided!`
            )
        }
        if (typeof req.body === 'undefined') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.processLoader - body not provided!`
            )
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const docLoaderId = req.params.loaderId
        const body = req.body
        const operationIdentity = getDocumentStoreOperationIdentity(req, body.storeId, workspaceId)
        const isInternalRequest = req.headers['x-request-from'] === 'internal'
        const apiResponse = await documentStoreService.processLoaderMiddleware(
            body,
            docLoaderId,
            orgId,
            workspaceId,
            subscriptionId,
            getRunningExpressApp().usageCacheManager,
            isInternalRequest,
            operationIdentity
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const updateDocumentStore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.updateDocumentStore - storeId not provided!`
            )
        }
        if (typeof req.body === 'undefined') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.updateDocumentStore - body not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.updateDocumentStore - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, req.params.id, workspaceId)
        const body = req.body
        if (body.name === undefined && body.description === undefined) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Document store metadata update is required')
        }
        const store = await documentStoreService.getDocumentStoreById(req.params.id, workspaceId)
        if (!store) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: documentStoreController.updateDocumentStore - DocumentStore ${req.params.id} not found in the database`
            )
        }
        const updateDocStore = new DocumentStore()
        // Public update is metadata-only. Loader, usage, vector configuration,
        // status and concurrency fields are owned by dedicated permissioned routes.
        if (body.name !== undefined) updateDocStore.name = body.name
        if (body.description !== undefined) updateDocStore.description = body.description
        const apiResponse = await documentStoreService.updateDocumentStore(store, updateDocStore, operationIdentity)
        return res.json(DocumentStoreDTO.fromEntity(apiResponse))
    } catch (error) {
        next(error)
    }
}

const deleteDocumentStore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.deleteDocumentStore - storeId not provided!`
            )
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, req.params.id, workspaceId)
        const apiResponse = await documentStoreService.deleteDocumentStore(
            req.params.id,
            orgId,
            workspaceId,
            getRunningExpressApp().usageCacheManager,
            operationIdentity
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const previewFileChunks = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.body === 'undefined') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.previewFileChunks - body not provided!`
            )
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const body = req.body
        if (body.storeId) {
            const store = await documentStoreService.getDocumentStoreById(body.storeId as string, workspaceId)
            if (!store) {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Document store not found')
            }
        }
        body.preview = true
        const apiResponse = await documentStoreService.previewChunksMiddleware(
            body,
            orgId,
            workspaceId,
            subscriptionId,
            getRunningExpressApp().usageCacheManager
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getDocumentLoaders = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await documentStoreService.getDocumentLoaders()
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const insertIntoVectorStore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.body === 'undefined') {
            throw new Error('Error: documentStoreController.insertIntoVectorStore - body not provided!')
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const body = req.body
        const isStrictSave = body.isStrictSave ?? false
        const operationIdentity = getDocumentStoreOperationIdentity(req, body.storeId, workspaceId)
        const apiResponse = await documentStoreService.insertIntoVectorStoreMiddleware(
            body,
            isStrictSave,
            orgId,
            workspaceId,
            subscriptionId,
            getRunningExpressApp().usageCacheManager,
            operationIdentity
        )
        await recordVectorStoreMetric(FLOWISE_COUNTER_STATUS.SUCCESS)
        return res.json(apiResponse)
    } catch (error) {
        await recordVectorStoreMetric(FLOWISE_COUNTER_STATUS.FAILURE)
        next(error)
    }
}

const queryVectorStore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.body === 'undefined') {
            throw new Error('Error: documentStoreController.queryVectorStore - body not provided!')
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store query is not authorized')
        }
        const body = req.body
        const apiResponse = await documentStoreService.queryVectorStore(body, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteVectorStoreFromStore = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.storeId === 'undefined' || req.params.storeId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.deleteVectorStoreFromStore - storeId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.deleteVectorStoreFromStore - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, req.params.storeId, workspaceId)
        const apiResponse = await documentStoreService.deleteVectorStoreFromStore(
            req.params.storeId,
            workspaceId,
            (req.query.docId as string) || undefined,
            operationIdentity
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const saveVectorStoreConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.body === 'undefined') {
            throw new Error('Error: documentStoreController.saveVectorStoreConfig - body not provided!')
        }
        const body = req.body
        const appDataSource = getRunningExpressApp().AppDataSource
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.saveVectorStoreConfig - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, body.storeId, workspaceId)
        const apiResponse = await documentStoreService.saveVectorStoreConfig(
            appDataSource,
            body,
            true,
            workspaceId,
            false,
            operationIdentity
        )
        return res.json(DocumentStoreDTO.fromEntity(apiResponse))
    } catch (error) {
        next(error)
    }
}

const updateVectorStoreConfigOnly = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.body === 'undefined') {
            throw new Error('Error: documentStoreController.updateVectorStoreConfigOnly - body not provided!')
        }
        const body = req.body
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.updateVectorStoreConfigOnly - workspaceId not provided!`
            )
        }
        const operationIdentity = getDocumentStoreOperationIdentity(req, body.storeId, workspaceId)
        const apiResponse = await documentStoreService.updateVectorStoreConfigOnly(body, workspaceId, operationIdentity)
        return res.json(DocumentStoreDTO.fromEntity(apiResponse))
    } catch (error) {
        next(error)
    }
}

const getEmbeddingProviders = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await documentStoreService.getEmbeddingProviders()
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getVectorStoreProviders = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await documentStoreService.getVectorStoreProviders()
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getRecordManagerProviders = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await documentStoreService.getRecordManagerProviders()
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const upsertDocStoreMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const files = (req.files as Express.Multer.File[]) || []
    let cleanupDelegatedToService = false
    try {
        const createNewDocStore = req.body?.createNewDocStore === true || req.body?.createNewDocStore === 'true'
        await assertDocumentStoreUpsertPermission(req, files, createNewDocStore)
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.upsertDocStoreMiddleware - storeId not provided!`
            )
        }
        if (typeof req.body === 'undefined') {
            throw new Error('Error: documentStoreController.upsertDocStoreMiddleware - body not provided!')
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const body = req.body
        const operationIdentity = createNewDocStore ? undefined : getDocumentStoreOperationIdentity(req, req.params.id, workspaceId)
        cleanupDelegatedToService = true
        const apiResponse = await documentStoreService.upsertDocStoreMiddleware(
            req.params.id,
            body,
            files,
            orgId,
            workspaceId,
            subscriptionId,
            getRunningExpressApp().usageCacheManager,
            operationIdentity
        )
        await recordVectorStoreMetric(FLOWISE_COUNTER_STATUS.SUCCESS)
        return res.json(apiResponse)
    } catch (error) {
        let responseError = error
        if (!cleanupDelegatedToService) {
            try {
                await cleanupRejectedDocumentStoreUploads(files)
            } catch (cleanupError) {
                responseError = cleanupError
            }
        }
        await recordVectorStoreMetric(FLOWISE_COUNTER_STATUS.FAILURE)
        next(responseError)
    }
}

const refreshDocStoreMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        await assertDocumentStoreUpsertPermission(req, [])
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.refreshDocStoreMiddleware - storeId not provided!`
            )
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - organizationId not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.createDocumentStore - workspaceId not provided!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const body = req.body
        const operationIdentity = getDocumentStoreOperationIdentity(req, req.params.id, workspaceId)
        const apiResponse = await documentStoreService.refreshDocStoreMiddleware(
            req.params.id,
            body,
            orgId,
            workspaceId,
            subscriptionId,
            getRunningExpressApp().usageCacheManager,
            operationIdentity
        )
        await recordVectorStoreMetric(FLOWISE_COUNTER_STATUS.SUCCESS)
        return res.json(apiResponse)
    } catch (error) {
        await recordVectorStoreMetric(FLOWISE_COUNTER_STATUS.FAILURE)
        next(error)
    }
}

const generateDocStoreToolDesc = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasDocumentStorePermission(req, 'documentStores:upsert-config')) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
        }
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.generateDocStoreToolDesc - storeId not provided!`
            )
        }
        if (typeof req.body === 'undefined') {
            throw new Error('Error: documentStoreController.generateDocStoreToolDesc - body not provided!')
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store tool description generation is not authorized')
        }
        const apiResponse = await documentStoreService.generateDocStoreToolDesc(req.params.id, req.body.selectedChatModel, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getDocStoreConfigs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.getDocStoreConfigs - storeId not provided!`
            )
        }
        if (typeof req.params.loaderId === 'undefined' || req.params.loaderId === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: documentStoreController.getDocStoreConfigs - doc loader Id not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
        const apiResponse = await documentStoreService.findDocStoreAvailableConfigs(req.params.id, req.params.loaderId, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    deleteDocumentStore,
    createDocumentStore,
    getAllDocumentStores,
    deleteLoaderFromDocumentStore,
    getDocumentStoreById,
    getDocumentStoreFileChunks,
    updateDocumentStore,
    processLoader,
    previewFileChunks,
    getDocumentLoaders,
    deleteDocumentStoreFileChunk,
    editDocumentStoreFileChunk,
    insertIntoVectorStore,
    getEmbeddingProviders,
    getVectorStoreProviders,
    getRecordManagerProviders,
    saveVectorStoreConfig,
    queryVectorStore,
    deleteVectorStoreFromStore,
    updateVectorStoreConfigOnly,
    upsertDocStoreMiddleware,
    refreshDocStoreMiddleware,
    saveProcessingLoader,
    generateDocStoreToolDesc,
    getDocStoreConfigs
}
