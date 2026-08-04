import { Request, Response } from 'express'
import { isUnsafeFilePath, removeSpecificFileFromUpload, streamStorageFile } from 'flowise-components'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import chatflowsService from '../../services/chatflows'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { validateFlowAPIKey } from '../../utils/validateKey'
import { validateFileMimeTypeAndExtensionMatch } from '../../utils/fileValidation'

const mockGetAllOpenaiAssistants = jest.fn()
const mockGetSingleOpenaiAssistant = jest.fn()
const mockUploadFilesToAssistant = jest.fn()

jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: { getChatflowById: jest.fn(), getChatflowByIdForWorkspace: jest.fn() }
}))

jest.mock('../../utils/validateKey', () => ({ validateFlowAPIKey: jest.fn() }))

jest.mock('../../services/openai-assistants', () => ({
    __esModule: true,
    default: {
        getAllOpenaiAssistants: (...args: unknown[]) => mockGetAllOpenaiAssistants(...args),
        getSingleOpenaiAssistant: (...args: unknown[]) => mockGetSingleOpenaiAssistant(...args),
        uploadFilesToAssistant: (...args: unknown[]) => mockUploadFilesToAssistant(...args)
    }
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('flowise-components', () => ({
    isUnsafeFilePath: jest.fn(),
    removeSpecificFileFromUpload: jest.fn(),
    streamStorageFile: jest.fn()
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        error: jest.fn()
    }
}))

jest.mock('../../utils/fileValidation', () => ({
    validateFileMimeTypeAndExtensionMatch: jest.fn()
}))

import openaiAssistantsController from '.'

const mockRemoveSpecificFileFromUpload = removeSpecificFileFromUpload as jest.Mock
const mockStreamStorageFile = streamStorageFile as jest.Mock
const mockIsUnsafeFilePath = isUnsafeFilePath as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const mockGetChatflowById = chatflowsService.getChatflowById as jest.Mock
const mockGetChatflowByIdForWorkspace = chatflowsService.getChatflowByIdForWorkspace as jest.Mock
const mockValidateFlowAPIKey = validateFlowAPIKey as jest.Mock
const mockLoggerError = logger.error as jest.Mock
const mockValidateFileMimeTypeAndExtensionMatch = validateFileMimeTypeAndExtensionMatch as jest.Mock

const chatMessageRepository = { find: jest.fn() }
const workspaceRepository = { findOneBy: jest.fn() }

const chatflow = {
    id: 'flow-1',
    workspaceId: 'workspace-1',
    type: EnumChatflowType.CHATFLOW,
    apikeyid: 'key-1'
}

const createResponse = () => {
    const res = {
        json: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
        setHeader: jest.fn()
    }
    res.status.mockReturnValue(res)
    return res as unknown as Response
}

describe('OpenAI Assistant controller workspace scoping', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetAllOpenaiAssistants.mockResolvedValue([])
        mockGetSingleOpenaiAssistant.mockResolvedValue({ id: 'asst-1' })
        mockUploadFilesToAssistant.mockResolvedValue([])
        mockRemoveSpecificFileFromUpload.mockResolvedValue(undefined)
        mockValidateFileMimeTypeAndExtensionMatch.mockReturnValue(undefined)
        mockIsUnsafeFilePath.mockReturnValue(false)
        mockGetChatflowById.mockResolvedValue(chatflow)
        mockGetChatflowByIdForWorkspace.mockResolvedValue(chatflow)
        mockValidateFlowAPIKey.mockResolvedValue(true)
        chatMessageRepository.find.mockResolvedValue([
            { chatflowid: 'flow-1', chatId: 'chat-1', fileAnnotations: JSON.stringify([{ fileName: 'report.txt' }]) }
        ])
        workspaceRepository.findOneBy.mockResolvedValue({ id: 'workspace-1', organizationId: 'org-1' })
        mockStreamStorageFile.mockResolvedValue(Buffer.from('file-content'))
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository: jest.fn((entity) => (entity === ChatMessage ? chatMessageRepository : workspaceRepository))
            }
        })
    })

    it('passes the active workspace to assistant list reads', async () => {
        const req = {
            query: { credential: 'credential-1' },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getAllOpenaiAssistants(req, res, next)

        expect(mockGetAllOpenaiAssistants).toHaveBeenCalledWith('credential-1', 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it('passes the active workspace to assistant detail reads', async () => {
        const req = {
            params: { id: 'asst-1' },
            query: { credential: 'credential-1' },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getSingleOpenaiAssistant(req, res, next)

        expect(mockGetSingleOpenaiAssistant).toHaveBeenCalledWith('credential-1', 'asst-1', 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it('passes the active workspace to assistant file uploads', async () => {
        const req = {
            query: { credential: 'credential-1' },
            files: [],
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.uploadAssistantFiles(req, res, next)

        expect(mockUploadFilesToAssistant).toHaveBeenCalledWith('credential-1', [], 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it.each([
        ['list', openaiAssistantsController.getAllOpenaiAssistants, { query: { credential: 'credential-1' } }],
        [
            'detail',
            openaiAssistantsController.getSingleOpenaiAssistant,
            { params: { id: 'asst-1' }, query: { credential: 'credential-1' } }
        ],
        ['upload', openaiAssistantsController.uploadAssistantFiles, { query: { credential: 'credential-1' }, files: [] }]
    ])('fails closed when the %s request has no active workspace', async (_name, handler, requestShape) => {
        const req = requestShape as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await handler(req, res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0]).toBeInstanceOf(InternalFlowiseError)
        expect(mockGetAllOpenaiAssistants).not.toHaveBeenCalled()
        expect(mockGetSingleOpenaiAssistant).not.toHaveBeenCalled()
        expect(mockUploadFilesToAssistant).not.toHaveBeenCalled()
    })

    it('cleans multer files when workspace validation fails before service delegation', async () => {
        const req = {
            query: { credential: 'credential-1' },
            files: [{ path: '/tmp/upload-1' }, { path: '/tmp/upload-1' }, { key: 'object-upload-2' }]
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.uploadAssistantFiles(req, res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(mockUploadFilesToAssistant).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/upload-1')
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('object-upload-2')
    })

    it('records cleanup failures without logging the path or raw error', async () => {
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('cannot delete /tmp/private-upload'))
        const req = {
            query: { credential: 'credential-1' },
            files: [{ path: '/tmp/private-upload' }]
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.uploadAssistantFiles(req, res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(mockLoggerError).toHaveBeenCalledWith('openai_assistant_controller_upload_cleanup_failed', {
            failedCount: 1,
            totalCount: 1
        })
        const serializedLogs = JSON.stringify(mockLoggerError.mock.calls)
        expect(serializedLogs).not.toContain('/tmp/private-upload')
        expect(serializedLogs).not.toContain('cannot delete')
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 500, message: 'Assistant upload cleanup failed' })
    })

    it('returns a fixed validation error and cleans the temporary upload', async () => {
        mockValidateFileMimeTypeAndExtensionMatch.mockImplementationOnce(() => {
            throw new Error('raw validation error for confidential-name.txt')
        })
        const req = {
            query: { credential: 'credential-1' },
            user: { activeWorkspaceId: 'workspace-1' },
            files: [
                {
                    path: '/tmp/private-upload',
                    originalname: Buffer.from('confidential-name.txt', 'utf8').toString('latin1'),
                    mimetype: 'text/plain'
                }
            ]
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.uploadAssistantFiles(req, res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0]).toMatchObject({
            statusCode: 400,
            message: 'Assistant file upload validation failed'
        })
        expect(JSON.stringify(next.mock.calls[0][0])).not.toContain('confidential-name')
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/private-upload')
        expect(mockUploadFilesToAssistant).not.toHaveBeenCalled()
    })

    it.each([
        [EnumChatflowType.CHATFLOW, 'chatflows:view'],
        [EnumChatflowType.AGENTFLOW, 'agentflows:view'],
        [EnumChatflowType.MULTIAGENT, 'agentflows:view'],
        [EnumChatflowType.ASSISTANT, 'assistants:view']
    ])('authorizes an authenticated %s file read with the matching view permission', async (type, permission) => {
        mockGetChatflowByIdForWorkspace.mockResolvedValueOnce({ ...chatflow, type })
        const req = {
            body: { chatflowId: ' flow-1 ', chatId: ' chat-1 ', fileName: ' report.txt ' },
            user: { activeWorkspaceId: 'workspace-1', permissions: [permission] }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getFileFromAssistant(req, res, next)

        expect(mockGetChatflowByIdForWorkspace).toHaveBeenCalledWith('flow-1', 'workspace-1')
        expect(mockValidateFlowAPIKey).not.toHaveBeenCalled()
        expect(chatMessageRepository.find).toHaveBeenCalledWith({
            where: { chatflowid: 'flow-1', chatId: 'chat-1' },
            select: ['fileAnnotations'],
            order: { createdDate: 'DESC', id: 'DESC' },
            take: 101
        })
        expect(mockStreamStorageFile).toHaveBeenCalledWith('flow-1', 'chat-1', 'report.txt', 'org-1')
        expect(res.send).toHaveBeenCalledWith(Buffer.from('file-content'))
        expect(next).not.toHaveBeenCalled()
    })

    it('rejects a cross-workspace authenticated file read before message or storage access', async () => {
        mockGetChatflowByIdForWorkspace.mockRejectedValueOnce(new Error('cross-workspace raw detail'))
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'report.txt' },
            user: { activeWorkspaceId: 'workspace-other', permissions: ['chatflows:view'] }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getFileFromAssistant(req, res, next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404, message: 'Assistant file was not found' })
        expect(chatMessageRepository.find).not.toHaveBeenCalled()
        expect(mockStreamStorageFile).not.toHaveBeenCalled()
    })

    it('rejects an authenticated user without the persisted flow-type permission', async () => {
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'report.txt' },
            user: { activeWorkspaceId: 'workspace-1', permissions: ['assistants:view'] }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getFileFromAssistant(req, res, next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403, message: 'Assistant file download is not authorized' })
        expect(chatMessageRepository.find).not.toHaveBeenCalled()
        expect(mockStreamStorageFile).not.toHaveBeenCalled()
    })

    it.each([
        ['missing', {}],
        ['wrong', { authorization: 'Bearer wrong-key' }]
    ])('rejects an anonymous protected-flow download with a %s API key', async (_case, headers) => {
        mockValidateFlowAPIKey.mockResolvedValueOnce(false)
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'report.txt' },
            headers
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getFileFromAssistant(req, res, next)

        expect(mockValidateFlowAPIKey).toHaveBeenCalledWith(req, chatflow)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, message: 'Assistant file download is not authorized' })
        expect(chatMessageRepository.find).not.toHaveBeenCalled()
        expect(mockStreamStorageFile).not.toHaveBeenCalled()
    })

    it('allows an anonymous download with the flow API key and exact scoped file annotation', async () => {
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'report.txt' },
            headers: { authorization: 'Bearer valid-key' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getFileFromAssistant(req, res, next)

        expect(mockGetChatflowById).toHaveBeenCalledWith('flow-1')
        expect(mockValidateFlowAPIKey).toHaveBeenCalledWith(req, chatflow)
        expect(chatMessageRepository.find).toHaveBeenCalledWith(
            expect.objectContaining({ where: { chatflowid: 'flow-1', chatId: 'chat-1' }, take: 101 })
        )
        expect(mockStreamStorageFile).toHaveBeenCalledWith('flow-1', 'chat-1', 'report.txt', 'org-1')
        expect(next).not.toHaveBeenCalled()
    })

    it('rejects an unannotated filename even when flow authorization succeeds', async () => {
        chatMessageRepository.find.mockResolvedValueOnce([
            { chatflowid: 'flow-1', chatId: 'chat-1', fileAnnotations: JSON.stringify([{ fileName: 'other.txt' }]) }
        ])
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'report.txt' },
            headers: { authorization: 'Bearer valid-key' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getFileFromAssistant(req, res, next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404, message: 'Assistant file was not found' })
        expect(mockStreamStorageFile).not.toHaveBeenCalled()
    })

    it('fails with a fixed error when the bounded message scan would be exceeded', async () => {
        chatMessageRepository.find.mockResolvedValueOnce(
            Array.from({ length: 101 }, () => ({ fileAnnotations: JSON.stringify([{ fileName: 'other.txt' }]) }))
        )
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'report.txt' },
            headers: { authorization: 'Bearer valid-key' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getFileFromAssistant(req, res, next)

        expect(next.mock.calls[0][0]).toMatchObject({
            statusCode: 413,
            message: 'Assistant file lookup exceeds the allowed limit'
        })
        expect(mockStreamStorageFile).not.toHaveBeenCalled()
    })

    it.each([
        [{ chatflowId: '', chatId: 'chat-1', fileName: 'report.txt' }],
        [{ chatflowId: 'flow-1', chatId: 'x'.repeat(257), fileName: 'report.txt' }],
        [{ chatflowId: 'flow-1', chatId: 'chat-1', fileName: '../report.txt' }],
        [{ chatflowId: 'flow-1', chatId: 'chat-1', fileName: 'x'.repeat(513) }]
    ])('rejects invalid assistant file identifiers with a fixed 400 before lookup %#', async (body) => {
        if (body.fileName === '../report.txt') mockIsUnsafeFilePath.mockReturnValueOnce(true)
        const req = { body, headers: {} } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await openaiAssistantsController.getFileFromAssistant(req, res, next)

        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400, message: 'Invalid assistant file download request' })
        expect(mockGetChatflowById).not.toHaveBeenCalled()
        expect(mockGetChatflowByIdForWorkspace).not.toHaveBeenCalled()
        expect(mockStreamStorageFile).not.toHaveBeenCalled()
    })
})
