import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import openAIAssistantVectorStoreService from '../../services/openai-assistants-vector-store'
import { validateFileMimeTypeAndExtensionMatch } from '../../utils/fileValidation'
import { removeSpecificFileFromUpload } from 'flowise-components'
import logger from '../../utils/logger'

jest.mock('../../services/openai-assistants-vector-store', () => ({
    __esModule: true,
    default: {
        uploadFilesToAssistantVectorStore: jest.fn()
    }
}))

jest.mock('../../utils/fileValidation', () => ({
    validateFileMimeTypeAndExtensionMatch: jest.fn()
}))

jest.mock('flowise-components', () => ({
    removeSpecificFileFromUpload: jest.fn()
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        error: jest.fn()
    }
}))

import openAIAssistantVectorStoreController from '.'

const mockUploadService = openAIAssistantVectorStoreService.uploadFilesToAssistantVectorStore as jest.Mock
const mockValidateFile = validateFileMimeTypeAndExtensionMatch as jest.Mock
const mockRemoveSpecificFileFromUpload = removeSpecificFileFromUpload as jest.Mock
const mockLoggerError = logger.error as jest.Mock

const createRequest = (overrides: Record<string, unknown> = {}) =>
    ({
        body: {},
        params: { id: 'vs-1' },
        query: { credential: 'credential-1' },
        user: { activeWorkspaceId: 'workspace-1' },
        files: [
            { originalname: 'one.txt', mimetype: 'text/plain', path: '/tmp/vector-one' },
            { originalname: 'two.txt', mimetype: 'text/plain', path: '/tmp/vector-two' }
        ],
        ...overrides
    } as any)

const createResponse = () => ({ json: jest.fn((value) => value) } as any)

describe('OpenAI Assistant vector store upload controller', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockUploadService.mockResolvedValue([{ id: 'file-1' }])
        mockRemoveSpecificFileFromUpload.mockResolvedValue(undefined)
    })

    it('delegates successful cleanup ownership to the service exactly once', async () => {
        const req = createRequest()
        const res = createResponse()
        const next = jest.fn()

        await openAIAssistantVectorStoreController.uploadFilesToAssistantVectorStore(req, res, next)

        expect(mockUploadService).toHaveBeenCalledWith(
            'credential-1',
            'vs-1',
            [
                { filePath: '/tmp/vector-one', fileName: 'one.txt' },
                { filePath: '/tmp/vector-two', fileName: 'two.txt' }
            ],
            'workspace-1'
        )
        expect(mockRemoveSpecificFileFromUpload).not.toHaveBeenCalled()
        expect(res.json).toHaveBeenCalledWith([{ id: 'file-1' }])
        expect(next).not.toHaveBeenCalled()
    })

    it('cleans every parsed temporary file and returns a fixed error when validation fails', async () => {
        mockValidateFile.mockImplementationOnce(() => {
            throw new Error('raw validator path /tmp/vector-one')
        })
        const next = jest.fn()

        await openAIAssistantVectorStoreController.uploadFilesToAssistantVectorStore(createRequest(), createResponse(), next)

        expect(mockUploadService).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/vector-one')
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/vector-two')
        expect(next).toHaveBeenCalledWith(expect.any(InternalFlowiseError))
        const error = next.mock.calls[0][0] as InternalFlowiseError
        expect(error.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(error.message).toBe('Assistant vector store file upload validation failed')
        expect(error.message).not.toContain('/tmp/vector-one')
    })

    it('cleans parsed files when workspace scope is missing', async () => {
        const next = jest.fn()

        await openAIAssistantVectorStoreController.uploadFilesToAssistantVectorStore(createRequest({ user: {} }), createResponse(), next)

        expect(mockUploadService).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: StatusCodes.NOT_FOUND }))
    })

    it('logs only aggregate cleanup metadata when controller cleanup fails', async () => {
        mockValidateFile.mockImplementationOnce(() => {
            throw new Error('validation failed')
        })
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('private path /tmp/vector-one'))
        const next = jest.fn()

        await openAIAssistantVectorStoreController.uploadFilesToAssistantVectorStore(createRequest(), createResponse(), next)

        expect(mockLoggerError).toHaveBeenCalledWith('openai_vector_store_controller_upload_cleanup_failed', {
            failedCount: 1,
            totalCount: 2
        })
        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
                message: 'Assistant vector store upload cleanup failed'
            })
        )
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('/tmp/vector-one')
    })
})
