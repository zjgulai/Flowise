import OpenAI from 'openai'
import { StatusCodes } from 'http-status-codes'
import { Credential } from '../../database/entities/Credential'
import { WorkspaceShared } from '../../enterprise/database/entities/EnterpriseEntities'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { decryptCredentialData } from '../../utils'
import { getFileFromUpload, removeSpecificFileFromUpload } from 'flowise-components'
import logger from '../../utils/logger'
import { assertOpenAIAssistantResourceCreationAllowed, assertOpenAIAssistantResourceDestructionAllowed } from '../assistants/legacyPolicy'

const MAX_VECTOR_STORE_FILE_PAGES = 1000
const MAX_VECTOR_STORE_FILES = 10_000
const MAX_VECTOR_STORE_PAGES = 1000
const MAX_VECTOR_STORES = 10_000
const FILE_RETRIEVAL_BATCH_SIZE = 20

const rethrowIfFlowiseError = (error: unknown): void => {
    if (error instanceof InternalFlowiseError) {
        throw error
    }
}

const logBatchFailure = (event: string, results: PromiseSettledResult<unknown>[], totalCount: number) => {
    const failedCount = results.filter((result) => result.status === 'rejected').length
    if (failedCount > 0) logger.error(event, { failedCount, totalCount })
    return failedCount
}

const listAllVectorStores = async (firstPage: any): Promise<any[]> => {
    const vectorStores: any[] = []
    const seenIds = new Set<string>()
    let page = firstPage

    for (let pageCount = 0; pageCount < MAX_VECTOR_STORE_PAGES; pageCount += 1) {
        if (!Array.isArray(page?.data)) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistant vector stores')
        }

        for (const vectorStore of page.data) {
            if (!vectorStore || typeof vectorStore.id !== 'string' || vectorStore.id.length === 0 || seenIds.has(vectorStore.id)) {
                throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistant vector stores')
            }
            seenIds.add(vectorStore.id)
            vectorStores.push(vectorStore)
        }

        if (vectorStores.length > MAX_VECTOR_STORES) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistant vector stores')
        }

        const hasNextPage = typeof page?.hasNextPage === 'function' ? page.hasNextPage() : page?.has_more === true
        if (!hasNextPage) return vectorStores
        if (typeof page?.getNextPage !== 'function') {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistant vector stores')
        }
        page = await page.getNextPage()
    }

    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistant vector stores')
}

const listAllVectorStoreFileIds = async (openai: OpenAI, vectorStoreId: string): Promise<string[]> => {
    const ids: string[] = []
    let page: any = await openai.vectorStores.files.list(vectorStoreId)
    for (let pageCount = 0; pageCount < MAX_VECTOR_STORE_FILE_PAGES; pageCount += 1) {
        if (!Array.isArray(page?.data)) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load vector store files')
        }
        const pageIds = page.data.map((file: { id?: unknown }) => file.id)
        if (pageIds.some((id: unknown) => typeof id !== 'string' || id.length === 0)) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load vector store files')
        }
        ids.push(...(pageIds as string[]))
        if (ids.length > MAX_VECTOR_STORE_FILES || new Set(ids).size !== ids.length) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load vector store files')
        }
        const hasNextPage = typeof page?.hasNextPage === 'function' ? page.hasNextPage() : page?.has_more === true
        if (!hasNextPage) return ids
        if (typeof page?.getNextPage !== 'function') {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load vector store files')
        }
        page = await page.getNextPage()
    }
    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load vector store files')
}

const retrieveFiles = async (openai: OpenAI, fileIds: string[]) => {
    const files: OpenAI.Files.FileObject[] = []
    for (let offset = 0; offset < fileIds.length; offset += FILE_RETRIEVAL_BATCH_SIZE) {
        files.push(...(await Promise.all(fileIds.slice(offset, offset + FILE_RETRIEVAL_BATCH_SIZE).map((id) => openai.files.retrieve(id)))))
    }
    return files
}

const resolveCredentialForWorkspace = async (credentialId: string, workspaceId: string): Promise<Credential> => {
    if (!workspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
    }
    const appServer = getRunningExpressApp()
    const credentialRepo = appServer.AppDataSource.getRepository(Credential)

    let credential = await credentialRepo.findOneBy({
        id: credentialId,
        workspaceId
    })
    if (!credential) {
        const share = await appServer.AppDataSource.getRepository(WorkspaceShared).findOneBy({
            workspaceId,
            sharedItemId: credentialId,
            itemType: 'credential'
        })
        if (share) {
            credential = await credentialRepo.findOneBy({ id: credentialId })
        }
    }
    if (credential) {
        return credential
    }
    throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Credential not found')
}

const getAssistantVectorStore = async (credentialId: string, vectorStoreId: string, workspaceId: string) => {
    try {
        const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
        // Decrpyt credentialData
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const openAIApiKey = decryptedCredentialData['openAIApiKey']
        if (!openAIApiKey) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `OpenAI ApiKey not found`)
        }

        const openai = new OpenAI({ apiKey: openAIApiKey })
        const dbResponse = await openai.vectorStores.retrieve(vectorStoreId)
        return dbResponse
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load OpenAI Assistant vector store')
    }
}

const listAssistantVectorStore = async (credentialId: string, workspaceId: string) => {
    try {
        const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
        // Decrpyt credentialData
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const openAIApiKey = decryptedCredentialData['openAIApiKey']
        if (!openAIApiKey) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `OpenAI ApiKey not found`)
        }

        const openai = new OpenAI({ apiKey: openAIApiKey })
        return await listAllVectorStores(await openai.vectorStores.list())
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistant vector stores')
    }
}

const createAssistantVectorStore = async (credentialId: string, obj: OpenAI.VectorStores.VectorStoreCreateParams, workspaceId: string) => {
    assertOpenAIAssistantResourceCreationAllowed()
    try {
        const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
        // Decrpyt credentialData
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const openAIApiKey = decryptedCredentialData['openAIApiKey']
        if (!openAIApiKey) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `OpenAI ApiKey not found`)
        }

        const openai = new OpenAI({ apiKey: openAIApiKey })
        const dbResponse = await openai.vectorStores.create(obj)
        return dbResponse
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to create OpenAI Assistant vector store')
    }
}

const updateAssistantVectorStore = async (
    credentialId: string,
    vectorStoreId: string,
    obj: OpenAI.VectorStores.VectorStoreUpdateParams,
    workspaceId: string
) => {
    try {
        const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
        // Decrpyt credentialData
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const openAIApiKey = decryptedCredentialData['openAIApiKey']
        if (!openAIApiKey) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `OpenAI ApiKey not found`)
        }

        const openai = new OpenAI({ apiKey: openAIApiKey })
        const dbResponse = await openai.vectorStores.update(vectorStoreId, obj)
        const fileIds = await listAllVectorStoreFileIds(openai, vectorStoreId)
        const files = await retrieveFiles(openai, fileIds)
        ;(dbResponse as any).files = files
        return dbResponse
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to update OpenAI Assistant vector store')
    }
}

const deleteAssistantVectorStore = async (credentialId: string, vectorStoreId: string, workspaceId: string) => {
    try {
        assertOpenAIAssistantResourceDestructionAllowed()
        const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
        // Decrpyt credentialData
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const openAIApiKey = decryptedCredentialData['openAIApiKey']
        if (!openAIApiKey) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `OpenAI ApiKey not found`)
        }

        const openai = new OpenAI({ apiKey: openAIApiKey })
        const dbResponse = await openai.vectorStores.delete(vectorStoreId)
        return dbResponse
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete OpenAI Assistant vector store')
    }
}

const uploadFilesToAssistantVectorStore = async (
    credentialId: string,
    vectorStoreId: string,
    files: { filePath: string; fileName: string }[],
    workspaceId: string
): Promise<any> => {
    assertOpenAIAssistantResourceCreationAllowed()
    let openai: OpenAI | undefined
    let operationError: unknown
    const uploadedFiles: OpenAI.Files.FileObject[] = []
    try {
        const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
        // Decrpyt credentialData
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const openAIApiKey = decryptedCredentialData['openAIApiKey']
        if (!openAIApiKey) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `OpenAI ApiKey not found`)
        }

        openai = new OpenAI({ apiKey: openAIApiKey })
        for (const file of files) {
            const fileBuffer = await getFileFromUpload(file.filePath)
            const toFile = await OpenAI.toFile(fileBuffer, file.fileName)
            const createdFile = await openai.files.create({
                file: toFile,
                purpose: 'assistants'
            })
            uploadedFiles.push(createdFile)
        }

        const file_ids = [...uploadedFiles.map((file) => file.id)]

        const res = await openai.vectorStores.fileBatches.createAndPoll(vectorStoreId, {
            file_ids
        })
        if (res.status !== 'completed' || res.file_counts.completed !== uploadedFiles.length) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to attach OpenAI Assistant vector store files')
        }
    } catch (error) {
        operationError = error
    }

    const filePaths = [
        ...new Set(
            files.map((file) => file.filePath).filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
        )
    ]
    const cleanupResults = await Promise.allSettled(filePaths.map((filePath) => removeSpecificFileFromUpload(filePath)))
    const cleanupFailureCount = logBatchFailure('openai_vector_store_upload_local_cleanup_failed', cleanupResults, filePaths.length)
    let compensationFailureCount = 0

    if (operationError || cleanupFailureCount > 0) {
        if (openai && uploadedFiles.length > 0) {
            const compensationResults = await Promise.allSettled(
                uploadedFiles.map(async (file) => {
                    const result = await openai!.files.delete(file.id)
                    if (!result.deleted) throw new Error('provider_compensation_not_confirmed')
                })
            )
            compensationFailureCount = logBatchFailure(
                'openai_vector_store_upload_remote_compensation_failed',
                compensationResults,
                uploadedFiles.length
            )
        }
        if (cleanupFailureCount > 0 || compensationFailureCount > 0) {
            throw new InternalFlowiseError(
                StatusCodes.INTERNAL_SERVER_ERROR,
                'Unable to finalize OpenAI Assistant vector store file upload'
            )
        }
        if (operationError) {
            rethrowIfFlowiseError(operationError)
        }
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to finalize OpenAI Assistant vector store file upload')
    }

    return uploadedFiles
}

const deleteFilesFromAssistantVectorStore = async (
    credentialId: string,
    vectorStoreId: string,
    file_ids: string[],
    workspaceId: string
) => {
    try {
        assertOpenAIAssistantResourceDestructionAllowed()
        const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
        // Decrpyt credentialData
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const openAIApiKey = decryptedCredentialData['openAIApiKey']
        if (!openAIApiKey) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `OpenAI ApiKey not found`)
        }

        const openai = new OpenAI({ apiKey: openAIApiKey })
        const deletedFileIds = []
        let count = 0
        for (const file of file_ids) {
            const res = await openai.vectorStores.files.delete(file, { vector_store_id: vectorStoreId })
            if (res.deleted) {
                deletedFileIds.push(file)
                count += 1
            }
        }

        return { deletedFileIds, count }
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to remove OpenAI Assistant vector store files')
    }
}

export default {
    getAssistantVectorStore,
    listAssistantVectorStore,
    createAssistantVectorStore,
    updateAssistantVectorStore,
    deleteAssistantVectorStore,
    uploadFilesToAssistantVectorStore,
    deleteFilesFromAssistantVectorStore
}
