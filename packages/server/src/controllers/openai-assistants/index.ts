import { Request, Response, NextFunction } from 'express'
import * as fs from 'fs'
import openaiAssistantsService from '../../services/openai-assistants'
import contentDisposition from 'content-disposition'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { StatusCodes } from 'http-status-codes'
import { isUnsafeFilePath, removeSpecificFileFromUpload, streamStorageFile } from 'flowise-components'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { Workspace } from '../../enterprise/database/entities/workspace.entity'
import { validateFileMimeTypeAndExtensionMatch } from '../../utils/fileValidation'
import logger from '../../utils/logger'
import chatflowsService from '../../services/chatflows'
import { validateFlowAPIKey } from '../../utils/validateKey'

const MAX_ASSISTANT_FILE_ID_LENGTH = 256
const MAX_ASSISTANT_FILE_NAME_LENGTH = 512
const MAX_FILE_ANNOTATIONS_LENGTH = 1024 * 1024
const MAX_ASSISTANT_FILE_MESSAGE_SCAN = 100
const INVALID_ASSISTANT_FILE_REQUEST = 'Invalid assistant file download request'
const ASSISTANT_FILE_NOT_FOUND = 'Assistant file was not found'
const ASSISTANT_FILE_DOWNLOAD_FAILED = 'Assistant file download failed'
const ASSISTANT_FILE_LOOKUP_LIMIT_EXCEEDED = 'Assistant file lookup exceeds the allowed limit'

const requireAssistantFileString = (value: unknown, maxLength: number): string => {
    if (typeof value !== 'string') throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, INVALID_ASSISTANT_FILE_REQUEST)
    const normalized = value.trim()
    if (!normalized || normalized.length > maxLength) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, INVALID_ASSISTANT_FILE_REQUEST)
    }
    return normalized
}

const assertAssistantFileFlowPermission = (req: Request, type: unknown): void => {
    if (req.user?.isOrganizationAdmin) return
    const permission =
        type === EnumChatflowType.CHATFLOW
            ? 'chatflows:view'
            : type === EnumChatflowType.AGENTFLOW || type === EnumChatflowType.MULTIAGENT
            ? 'agentflows:view'
            : type === EnumChatflowType.ASSISTANT
            ? 'assistants:view'
            : undefined
    if (!permission || !req.user?.permissions?.includes(permission)) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Assistant file download is not authorized')
    }
}

const resolveAuthorizedAssistantFileFlow = async (req: Request, chatflowId: string) => {
    try {
        if (req.user) {
            const workspaceId = req.user.activeWorkspaceId
            if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Assistant file download is not authorized')
            const chatflow = await chatflowsService.getChatflowByIdForWorkspace(chatflowId, workspaceId)
            assertAssistantFileFlowPermission(req, chatflow.type)
            return chatflow
        }

        const chatflow = await chatflowsService.getChatflowById(chatflowId)
        if (!(await validateFlowAPIKey(req, chatflow))) {
            throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Assistant file download is not authorized')
        }
        return chatflow
    } catch (error) {
        if (error instanceof InternalFlowiseError && [StatusCodes.FORBIDDEN, StatusCodes.UNAUTHORIZED].includes(error.statusCode)) {
            throw error
        }
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, ASSISTANT_FILE_NOT_FOUND)
    }
}

const hasScopedFileAnnotation = (fileAnnotations: unknown, fileName: string): boolean => {
    if (typeof fileAnnotations !== 'string' || !fileAnnotations || fileAnnotations.length > MAX_FILE_ANNOTATIONS_LENGTH) return false
    try {
        const annotations = JSON.parse(fileAnnotations)
        return Array.isArray(annotations) && annotations.some((annotation) => annotation?.fileName === fileName)
    } catch {
        return false
    }
}

const getActiveWorkspaceId = (req: Request, operation: string): string => {
    const workspaceId = req.user?.activeWorkspaceId
    if (!workspaceId) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Error: ${operation} - workspace not found!`)
    }
    return workspaceId
}

// List available assistants
const getAllOpenaiAssistants = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.query === 'undefined' || !req.query.credential) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: openaiAssistantsController.getAllOpenaiAssistants - credential not provided!`
            )
        }
        const workspaceId = getActiveWorkspaceId(req, 'openaiAssistantsController.getAllOpenaiAssistants')
        const apiResponse = await openaiAssistantsService.getAllOpenaiAssistants(req.query.credential as string, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// Get assistant object
const getSingleOpenaiAssistant = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: openaiAssistantsController.getSingleOpenaiAssistant - id not provided!`
            )
        }
        if (typeof req.query === 'undefined' || !req.query.credential) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: openaiAssistantsController.getSingleOpenaiAssistant - credential not provided!`
            )
        }
        const workspaceId = getActiveWorkspaceId(req, 'openaiAssistantsController.getSingleOpenaiAssistant')
        const apiResponse = await openaiAssistantsService.getSingleOpenaiAssistant(
            req.query.credential as string,
            req.params.id,
            workspaceId
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// Download file from assistant
const getFileFromAssistant = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const chatflowId = requireAssistantFileString(req.body?.chatflowId, MAX_ASSISTANT_FILE_ID_LENGTH)
        const chatId = requireAssistantFileString(req.body?.chatId, MAX_ASSISTANT_FILE_ID_LENGTH)
        const fileName = requireAssistantFileString(req.body?.fileName, MAX_ASSISTANT_FILE_NAME_LENGTH)
        if (isUnsafeFilePath(fileName)) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, INVALID_ASSISTANT_FILE_REQUEST)

        const appServer = getRunningExpressApp()
        const chatflow = await resolveAuthorizedAssistantFileFlow(req, chatflowId)

        const scopedMessages = await appServer.AppDataSource.getRepository(ChatMessage).find({
            where: { chatflowid: chatflowId, chatId },
            select: ['fileAnnotations'],
            order: { createdDate: 'DESC', id: 'DESC' },
            take: MAX_ASSISTANT_FILE_MESSAGE_SCAN + 1
        })
        if (scopedMessages.length > MAX_ASSISTANT_FILE_MESSAGE_SCAN) {
            throw new InternalFlowiseError(StatusCodes.REQUEST_TOO_LONG, ASSISTANT_FILE_LOOKUP_LIMIT_EXCEEDED)
        }
        if (!scopedMessages.some((message) => hasScopedFileAnnotation(message.fileAnnotations, fileName))) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, ASSISTANT_FILE_NOT_FOUND)
        }

        const chatflowWorkspaceId = chatflow.workspaceId
        if (typeof chatflowWorkspaceId !== 'string' || !chatflowWorkspaceId) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, ASSISTANT_FILE_NOT_FOUND)
        }
        const workspace = await appServer.AppDataSource.getRepository(Workspace).findOneBy({
            id: chatflowWorkspaceId
        })
        if (!workspace?.organizationId) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, ASSISTANT_FILE_NOT_FOUND)
        const orgId = workspace.organizationId as string

        const fileStream = await streamStorageFile(chatflowId, chatId, fileName, orgId)
        if (!fileStream) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, ASSISTANT_FILE_NOT_FOUND)

        res.setHeader('Content-Disposition', contentDisposition(fileName))
        if (fileStream instanceof fs.ReadStream && fileStream?.pipe) {
            fileStream.pipe(res)
        } else {
            res.send(fileStream)
        }
    } catch (error) {
        next(
            error instanceof InternalFlowiseError
                ? error
                : new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, ASSISTANT_FILE_DOWNLOAD_FAILED)
        )
    }
}

const uploadAssistantFiles = async (req: Request, res: Response, next: NextFunction) => {
    let cleanupDelegatedToService = false
    try {
        if (typeof req.query === 'undefined' || !req.query.credential) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: openaiAssistantsController.uploadAssistantFiles - credential not provided!`
            )
        }
        const workspaceId = getActiveWorkspaceId(req, 'openaiAssistantsController.uploadAssistantFiles')
        const files = req.files ?? []
        const uploadFiles: { filePath: string; fileName: string }[] = []

        if (Array.isArray(files)) {
            for (const file of files) {
                // Address file name with special characters: https://github.com/expressjs/multer/issues/1104
                file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')

                // Validate file extension, MIME type, and content to prevent security vulnerabilities
                try {
                    validateFileMimeTypeAndExtensionMatch(file.originalname, file.mimetype)
                } catch {
                    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Assistant file upload validation failed')
                }

                const filePath = file.path ?? file.key
                if (typeof filePath !== 'string' || !filePath) {
                    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid temporary upload path')
                }

                uploadFiles.push({
                    filePath,
                    fileName: file.originalname
                })
            }
        }

        cleanupDelegatedToService = true
        const apiResponse = await openaiAssistantsService.uploadFilesToAssistant(req.query.credential as string, uploadFiles, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        let responseError = error
        if (!cleanupDelegatedToService && Array.isArray(req.files)) {
            const filePaths = [
                ...new Set(
                    req.files
                        .map((file) => file.path ?? file.key)
                        .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
                )
            ]
            const cleanupResults = await Promise.allSettled(filePaths.map(async (filePath) => removeSpecificFileFromUpload(filePath)))
            const failedCount = cleanupResults.filter((result) => result.status === 'rejected').length
            if (failedCount > 0) {
                logger.error('openai_assistant_controller_upload_cleanup_failed', {
                    failedCount,
                    totalCount: filePaths.length
                })
                responseError = new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Assistant upload cleanup failed')
            }
        }
        next(responseError)
    }
}

export default {
    getAllOpenaiAssistants,
    getSingleOpenaiAssistant,
    getFileFromAssistant,
    uploadAssistantFiles
}
