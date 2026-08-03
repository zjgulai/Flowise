import OpenAI from 'openai'
import { StatusCodes } from 'http-status-codes'
import { decryptCredentialData } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { Credential } from '../../database/entities/Credential'
import { WorkspaceShared } from '../../enterprise/database/entities/EnterpriseEntities'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getFileFromUpload, removeSpecificFileFromUpload } from 'flowise-components'
import logger from '../../utils/logger'
import { assertOpenAIAssistantResourceCreationAllowed } from '../assistants/legacyPolicy'

const MAX_ASSISTANT_PAGES = 1000
const MAX_ASSISTANTS = 10_000

// ----------------------------------------
// Assistants
// ----------------------------------------

const rethrowIfFlowiseError = (error: unknown): void => {
    if (error instanceof InternalFlowiseError) {
        throw error
    }
}

const resolveCredentialForWorkspace = async (credentialId: string, workspaceId: string): Promise<Credential> => {
    if (!workspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
    }

    const appServer = getRunningExpressApp()
    const credentialRepository = appServer.AppDataSource.getRepository(Credential)
    const ownedCredential = await credentialRepository.findOneBy({ id: credentialId, workspaceId })
    if (ownedCredential) return ownedCredential

    const sharedCredential = await appServer.AppDataSource.getRepository(WorkspaceShared).findOneBy({
        workspaceId,
        sharedItemId: credentialId,
        itemType: 'credential'
    })
    if (sharedCredential) {
        const credential = await credentialRepository.findOneBy({ id: credentialId })
        if (credential) return credential
    }

    throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Credential not found')
}

const createOpenAIClientForWorkspace = async (credentialId: string, workspaceId: string): Promise<OpenAI> => {
    const credential = await resolveCredentialForWorkspace(credentialId, workspaceId)
    const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
    const openAIApiKey = decryptedCredentialData['openAIApiKey']
    if (!openAIApiKey) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'OpenAI ApiKey not found')
    }
    return new OpenAI({ apiKey: openAIApiKey })
}

const retrieveAssociatedFiles = async (openai: OpenAI, fileIds: string[]) => {
    const uniqueFileIds = [...new Set(fileIds)]
    const files: OpenAI.Files.FileObject[] = []
    for (let offset = 0; offset < uniqueFileIds.length; offset += 20) {
        files.push(...(await Promise.all(uniqueFileIds.slice(offset, offset + 20).map((fileId) => openai.files.retrieve(fileId)))))
    }
    return files
}

const listAllVectorStoreFileIds = async (openai: OpenAI, vectorStoreId: string): Promise<string[]> => {
    const ids: string[] = []
    let page: any = await openai.vectorStores.files.list(vectorStoreId)
    for (let pageCount = 0; pageCount < 1000; pageCount += 1) {
        if (!Array.isArray(page?.data)) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load OpenAI Assistant details')
        }
        const pageIds = page.data.map((file: { id?: unknown }) => file.id)
        if (pageIds.some((id: unknown) => typeof id !== 'string' || id.length === 0)) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load OpenAI Assistant details')
        }
        ids.push(...(pageIds as string[]))
        if (ids.length > 10_000 || new Set(ids).size !== ids.length) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load OpenAI Assistant details')
        }
        const hasNextPage = typeof page?.hasNextPage === 'function' ? page.hasNextPage() : page?.has_more === true
        if (!hasNextPage) return ids
        if (typeof page?.getNextPage !== 'function') {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load OpenAI Assistant details')
        }
        page = await page.getNextPage()
    }
    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load OpenAI Assistant details')
}

const logBatchFailure = (event: string, results: PromiseSettledResult<unknown>[], totalCount: number) => {
    const failedCount = results.filter((result) => result.status === 'rejected').length
    if (failedCount > 0) {
        logger.error(event, { failedCount, totalCount })
    }
    return failedCount
}

const listAllAssistants = async (firstPage: any): Promise<any[]> => {
    const assistants: any[] = []
    const seenIds = new Set<string>()
    let page = firstPage

    for (let pageCount = 0; pageCount < MAX_ASSISTANT_PAGES; pageCount += 1) {
        if (!Array.isArray(page?.data)) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistants')
        }

        for (const assistant of page.data) {
            if (!assistant || typeof assistant.id !== 'string' || assistant.id.length === 0 || seenIds.has(assistant.id)) {
                throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistants')
            }
            seenIds.add(assistant.id)
            assistants.push(assistant)
        }

        if (assistants.length > MAX_ASSISTANTS) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistants')
        }

        const hasNextPage = typeof page?.hasNextPage === 'function' ? page.hasNextPage() : page?.has_more === true
        if (!hasNextPage) return assistants
        if (typeof page?.getNextPage !== 'function') {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistants')
        }
        page = await page.getNextPage()
    }

    throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistants')
}

// List available assistants
const getAllOpenaiAssistants = async (credentialId: string, workspaceId: string): Promise<any> => {
    try {
        const openai = await createOpenAIClientForWorkspace(credentialId, workspaceId)
        return await listAllAssistants(await openai.beta.assistants.list())
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to list OpenAI Assistants')
    }
}

// Get assistant object
const getSingleOpenaiAssistant = async (credentialId: string, assistantId: string, workspaceId: string): Promise<any> => {
    try {
        const openai = await createOpenAIClientForWorkspace(credentialId, workspaceId)
        const dbResponse = await openai.beta.assistants.retrieve(assistantId)
        if (dbResponse.tool_resources?.code_interpreter?.file_ids?.length) {
            const fileIds = dbResponse.tool_resources.code_interpreter.file_ids
            ;(dbResponse.tool_resources.code_interpreter as any).files = await retrieveAssociatedFiles(openai, fileIds)
        }
        if (dbResponse.tool_resources?.file_search?.vector_store_ids?.length) {
            // Since there can only be 1 vector store per assistant
            const vectorStoreId = dbResponse.tool_resources.file_search.vector_store_ids[0]
            const fileIds = await listAllVectorStoreFileIds(openai, vectorStoreId)
            ;(dbResponse.tool_resources.file_search as any).files = await retrieveAssociatedFiles(openai, fileIds)
            ;(dbResponse.tool_resources.file_search as any).vector_store_object = await openai.vectorStores.retrieve(vectorStoreId)
        }
        return dbResponse
    } catch (error) {
        rethrowIfFlowiseError(error)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to load OpenAI Assistant details')
    }
}

const uploadFilesToAssistant = async (credentialId: string, files: { filePath: string; fileName: string }[], workspaceId: string) => {
    assertOpenAIAssistantResourceCreationAllowed()
    let openai: OpenAI | undefined
    let operationError: unknown
    const uploadedFiles: OpenAI.Files.FileObject[] = []
    try {
        openai = await createOpenAIClientForWorkspace(credentialId, workspaceId)

        for (const file of files) {
            const fileBuffer = await getFileFromUpload(file.filePath)
            const toFile = await OpenAI.toFile(fileBuffer, file.fileName)
            const createdFile = await openai.files.create({
                file: toFile,
                purpose: 'assistants'
            })
            uploadedFiles.push(createdFile)
        }
    } catch (error) {
        operationError = error
    }

    const filePaths = [
        ...new Set(
            files.map((file) => file.filePath).filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
        )
    ]
    const cleanupResults = await Promise.allSettled(filePaths.map(async (filePath) => removeSpecificFileFromUpload(filePath)))
    const cleanupFailureCount = logBatchFailure('openai_assistant_upload_local_cleanup_failed', cleanupResults, filePaths.length)

    if (operationError || cleanupFailureCount > 0) {
        let compensationFailureCount = 0
        if (openai && uploadedFiles.length > 0) {
            const compensationResults = await Promise.allSettled(
                uploadedFiles.map(async (file) => {
                    const result = await openai!.files.delete(file.id)
                    if (!result.deleted) throw new Error('provider_compensation_not_confirmed')
                })
            )
            compensationFailureCount = logBatchFailure(
                'openai_assistant_upload_remote_compensation_failed',
                compensationResults,
                uploadedFiles.length
            )
        }

        if (cleanupFailureCount > 0 || compensationFailureCount > 0) {
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to finalize OpenAI Assistant file upload')
        }

        if (operationError) {
            rethrowIfFlowiseError(operationError)
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to upload OpenAI Assistant files')
        }

        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to finalize OpenAI Assistant file upload')
    }

    return uploadedFiles
}

export default {
    getAllOpenaiAssistants,
    getSingleOpenaiAssistant,
    uploadFilesToAssistant
}
