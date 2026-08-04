import OpenAI from 'openai'
import { StatusCodes } from 'http-status-codes'
import { Credential } from '../../database/entities/Credential'
import { WorkspaceShared } from '../../enterprise/database/entities/EnterpriseEntities'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { decryptCredentialData } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { getFileFromUpload, removeSpecificFileFromUpload } from 'flowise-components'
import logger from '../../utils/logger'

jest.mock('openai', () => {
    const OpenAIMock = jest.fn()
    ;(OpenAIMock as any).toFile = jest.fn()
    return { __esModule: true, default: OpenAIMock }
})

jest.mock('../../utils', () => ({
    decryptCredentialData: jest.fn()
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('flowise-components', () => ({
    getFileFromUpload: jest.fn(),
    removeSpecificFileFromUpload: jest.fn()
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        error: jest.fn()
    }
}))

const mockAssertOpenAIAssistantResourceCreationAllowed = jest.fn()

jest.mock('../assistants/legacyPolicy', () => ({
    assertOpenAIAssistantResourceCreationAllowed: () => mockAssertOpenAIAssistantResourceCreationAllowed()
}))

import openaiAssistantsService from '.'

const mockOpenAI = OpenAI as unknown as jest.Mock
const mockDecryptCredentialData = decryptCredentialData as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const mockGetFileFromUpload = getFileFromUpload as jest.Mock
const mockRemoveSpecificFileFromUpload = removeSpecificFileFromUpload as jest.Mock
const mockToFile = OpenAI.toFile as jest.Mock
const mockLoggerError = logger.error as jest.Mock

const credential = {
    id: 'credential-1',
    workspaceId: 'workspace-owner',
    encryptedData: 'encrypted-openai-key'
} as Credential

const credentialRepository = {
    findOneBy: jest.fn()
}

const sharedRepository = {
    findOneBy: jest.fn()
}

const mockOpenAIClient = {
    beta: {
        assistants: {
            list: jest.fn(),
            retrieve: jest.fn()
        }
    },
    files: {
        list: jest.fn(),
        create: jest.fn(),
        retrieve: jest.fn(),
        delete: jest.fn()
    },
    vectorStores: {
        files: {
            list: jest.fn()
        },
        retrieve: jest.fn()
    }
}

describe('OpenAI Assistant service credential scoping', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        credentialRepository.findOneBy.mockResolvedValue(credential)
        sharedRepository.findOneBy.mockResolvedValue(null)
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository: jest.fn((entity) => {
                    if (entity === Credential) return credentialRepository
                    if (entity === WorkspaceShared) return sharedRepository
                    throw new Error('Unexpected repository')
                })
            }
        })
        mockDecryptCredentialData.mockResolvedValue({ openAIApiKey: 'test-openai-key' })
        mockOpenAI.mockImplementation(() => mockOpenAIClient)
        mockOpenAIClient.beta.assistants.list.mockResolvedValue({ data: [{ id: 'asst-1' }] })
        mockOpenAIClient.beta.assistants.retrieve.mockResolvedValue({ id: 'asst-1', tool_resources: {} })
        mockOpenAIClient.files.list.mockResolvedValue({ data: [] })
        mockOpenAIClient.files.create.mockResolvedValue({ id: 'file-1' })
        mockOpenAIClient.files.retrieve.mockImplementation(async (fileId) => ({ id: fileId }))
        mockOpenAIClient.files.delete.mockResolvedValue({ deleted: true })
        mockOpenAIClient.vectorStores.retrieve.mockResolvedValue({ id: 'vs-1', name: 'Knowledge Base' })
        mockGetFileFromUpload.mockResolvedValue(Buffer.from('file'))
        mockToFile.mockResolvedValue({ name: 'file.txt' })
        mockRemoveSpecificFileFromUpload.mockResolvedValue(undefined)
        mockAssertOpenAIAssistantResourceCreationAllowed.mockImplementation(() => undefined)
    })

    it('resolves an owned credential with both credential and workspace IDs', async () => {
        await expect(openaiAssistantsService.getAllOpenaiAssistants('credential-1', 'workspace-owner')).resolves.toEqual([{ id: 'asst-1' }])

        expect(credentialRepository.findOneBy).toHaveBeenCalledWith({
            id: 'credential-1',
            workspaceId: 'workspace-owner'
        })
        expect(sharedRepository.findOneBy).not.toHaveBeenCalled()
    })

    it('allows a credential explicitly shared with the active workspace', async () => {
        credentialRepository.findOneBy.mockImplementation(async (where) => {
            if ('workspaceId' in where) return null
            return credential
        })
        sharedRepository.findOneBy.mockResolvedValue({
            workspaceId: 'workspace-shared',
            sharedItemId: 'credential-1',
            itemType: 'credential'
        })

        await expect(openaiAssistantsService.getAllOpenaiAssistants('credential-1', 'workspace-shared')).resolves.toEqual([
            { id: 'asst-1' }
        ])

        expect(sharedRepository.findOneBy).toHaveBeenCalledWith({
            workspaceId: 'workspace-shared',
            sharedItemId: 'credential-1',
            itemType: 'credential'
        })
        expect(credentialRepository.findOneBy).toHaveBeenLastCalledWith({ id: 'credential-1' })
    })

    it('returns assistants from every Provider page', async () => {
        const secondPage = { data: [{ id: 'asst-2' }], hasNextPage: () => false }
        const firstPage = {
            data: [{ id: 'asst-1' }],
            hasNextPage: () => true,
            getNextPage: jest.fn().mockResolvedValue(secondPage)
        }
        mockOpenAIClient.beta.assistants.list.mockResolvedValueOnce(firstPage)

        await expect(openaiAssistantsService.getAllOpenaiAssistants('credential-1', 'workspace-owner')).resolves.toEqual([
            { id: 'asst-1' },
            { id: 'asst-2' }
        ])
        expect(firstPage.getNextPage).toHaveBeenCalledTimes(1)
    })

    it('rejects duplicate assistant IDs across Provider pages', async () => {
        const secondPage = { data: [{ id: 'asst-1' }], hasNextPage: () => false }
        mockOpenAIClient.beta.assistants.list.mockResolvedValueOnce({
            data: [{ id: 'asst-1' }],
            hasNextPage: () => true,
            getNextPage: jest.fn().mockResolvedValue(secondPage)
        })

        await expect(openaiAssistantsService.getAllOpenaiAssistants('credential-1', 'workspace-owner')).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to list OpenAI Assistants'
        })
    })

    it.each([
        ['list', () => openaiAssistantsService.getAllOpenaiAssistants('credential-secret-id', 'workspace-attacker')],
        ['detail', () => openaiAssistantsService.getSingleOpenaiAssistant('credential-secret-id', 'asst-1', 'workspace-attacker')],
        [
            'upload',
            () =>
                openaiAssistantsService.uploadFilesToAssistant(
                    'credential-secret-id',
                    [{ filePath: '/tmp/untrusted', fileName: 'untrusted.txt' }],
                    'workspace-attacker'
                )
        ]
    ])('rejects a cross-workspace credential before the %s Provider operation', async (name, operation) => {
        credentialRepository.findOneBy.mockResolvedValue(null)
        sharedRepository.findOneBy.mockResolvedValue(null)

        let caught: unknown
        try {
            await operation()
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(InternalFlowiseError)
        expect((caught as InternalFlowiseError).statusCode).toBe(StatusCodes.NOT_FOUND)
        expect((caught as Error).message).toBe('Credential not found')
        expect((caught as Error).message).not.toContain('credential-secret-id')
        expect(mockDecryptCredentialData).not.toHaveBeenCalled()
        expect(mockOpenAI).not.toHaveBeenCalled()
        expect(mockGetFileFromUpload).not.toHaveBeenCalled()
        if (name === 'upload') {
            expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/untrusted')
        } else {
            expect(mockRemoveSpecificFileFromUpload).not.toHaveBeenCalled()
        }
    })

    it('rejects an unscoped service call before querying credentials', async () => {
        await expect(openaiAssistantsService.getAllOpenaiAssistants('credential-1', '')).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Workspace ID is required'
        })

        expect(credentialRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockOpenAI).not.toHaveBeenCalled()
    })

    it('rejects direct legacy uploads before filesystem, credential, or Provider access', async () => {
        mockAssertOpenAIAssistantResourceCreationAllowed.mockImplementationOnce(() => {
            throw new InternalFlowiseError(
                StatusCodes.GONE,
                'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
            )
        })
        await expect(
            openaiAssistantsService.uploadFilesToAssistant(
                'credential-1',
                [
                    { filePath: '/tmp/upload-1', fileName: 'one.txt' },
                    { filePath: '/tmp/upload-2', fileName: 'two.txt' }
                ],
                'workspace-owner'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.GONE,
            message: 'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
        })

        expect(credentialRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockDecryptCredentialData).not.toHaveBeenCalled()
        expect(mockGetFileFromUpload).not.toHaveBeenCalled()
        expect(mockOpenAI).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).not.toHaveBeenCalled()
    })

    it('cleans every local temporary file when a Provider upload fails partway through', async () => {
        mockOpenAIClient.files.create.mockResolvedValueOnce({ id: 'remote-file-1' }).mockRejectedValueOnce(new Error('provider failed'))

        await expect(
            openaiAssistantsService.uploadFilesToAssistant(
                'credential-1',
                [
                    { filePath: '/tmp/upload-1', fileName: 'one.txt' },
                    { filePath: '/tmp/upload-2', fileName: 'two.txt' },
                    { filePath: '/tmp/upload-2', fileName: 'two-duplicate.txt' }
                ],
                'workspace-owner'
            )
        ).rejects.toThrow('Unable to upload OpenAI Assistant files')

        expect(mockOpenAIClient.files.create).toHaveBeenCalledTimes(2)
        expect(mockOpenAIClient.files.delete).toHaveBeenCalledWith('remote-file-1')
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/upload-1')
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/upload-2')
    })

    it('cleans every local temporary file when reading an upload fails', async () => {
        mockGetFileFromUpload.mockRejectedValueOnce(new Error('local read failed'))

        await expect(
            openaiAssistantsService.uploadFilesToAssistant(
                'credential-1',
                [
                    { filePath: '/tmp/upload-1', fileName: 'one.txt' },
                    { filePath: '/tmp/upload-2', fileName: 'two.txt' }
                ],
                'workspace-owner'
            )
        ).rejects.toThrow('Unable to upload OpenAI Assistant files')

        expect(mockOpenAIClient.files.create).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/upload-1')
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/upload-2')
    })

    it('cleans local files after successful uploads without deleting remote files', async () => {
        const result = await openaiAssistantsService.uploadFilesToAssistant(
            'credential-1',
            [{ filePath: '/tmp/upload-1', fileName: 'one.txt' }],
            'workspace-owner'
        )

        expect(result).toEqual([{ id: 'file-1' }])
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/upload-1')
        expect(mockOpenAIClient.files.delete).not.toHaveBeenCalled()
    })

    it('returns a fixed error when local cleanup fails after a successful Provider upload', async () => {
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('failed to delete /tmp/private-upload'))

        let caught: unknown
        try {
            await openaiAssistantsService.uploadFilesToAssistant(
                'credential-1',
                [{ filePath: '/tmp/private-upload', fileName: 'one.txt' }],
                'workspace-owner'
            )
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(InternalFlowiseError)
        expect((caught as InternalFlowiseError).statusCode).toBe(StatusCodes.INTERNAL_SERVER_ERROR)
        expect((caught as Error).message).toBe('Unable to finalize OpenAI Assistant file upload')
        expect((caught as Error).message).not.toContain('/tmp/private-upload')
        expect(mockOpenAIClient.files.delete).toHaveBeenCalledWith('file-1')
        expect(mockLoggerError).toHaveBeenCalledWith('openai_assistant_upload_local_cleanup_failed', {
            failedCount: 1,
            totalCount: 1
        })
    })

    it('does not leak Provider details when list or detail requests fail', async () => {
        mockOpenAIClient.beta.assistants.list.mockRejectedValueOnce(new Error('provider token secret-list'))
        mockOpenAIClient.beta.assistants.retrieve.mockRejectedValueOnce(new Error('provider token secret-detail'))

        await expect(openaiAssistantsService.getAllOpenaiAssistants('credential-1', 'workspace-owner')).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to list OpenAI Assistants'
        })
        await expect(openaiAssistantsService.getSingleOpenaiAssistant('credential-1', 'asst-1', 'workspace-owner')).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to load OpenAI Assistant details'
        })
    })

    it('retrieves every associated code interpreter file directly instead of using the default list page', async () => {
        const assistant = {
            id: 'asst-1',
            tool_resources: {
                code_interpreter: {
                    file_ids: ['file-page-2', 'file-page-7']
                }
            }
        }
        mockOpenAIClient.beta.assistants.retrieve.mockResolvedValueOnce(assistant)
        mockOpenAIClient.files.retrieve.mockImplementation(async (fileId) => ({ id: fileId, filename: `${fileId}.txt` }))

        const result = await openaiAssistantsService.getSingleOpenaiAssistant('credential-1', 'asst-1', 'workspace-owner')

        expect(mockOpenAIClient.files.list).not.toHaveBeenCalled()
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledTimes(2)
        expect(mockOpenAIClient.files.retrieve).toHaveBeenNthCalledWith(1, 'file-page-2')
        expect(mockOpenAIClient.files.retrieve).toHaveBeenNthCalledWith(2, 'file-page-7')
        expect(result.tool_resources.code_interpreter.files).toEqual([
            { id: 'file-page-2', filename: 'file-page-2.txt' },
            { id: 'file-page-7', filename: 'file-page-7.txt' }
        ])
    })

    it('retrieves file-search resources from every vector store page', async () => {
        const assistant = {
            id: 'asst-1',
            tool_resources: {
                file_search: {
                    vector_store_ids: ['vs-1']
                }
            }
        }
        const secondPage = { data: [{ id: 'file-page-2' }], hasNextPage: () => false }
        const firstPage = {
            data: [{ id: 'file-page-1' }],
            hasNextPage: () => true,
            getNextPage: jest.fn().mockResolvedValue(secondPage)
        }
        mockOpenAIClient.beta.assistants.retrieve.mockResolvedValueOnce(assistant)
        mockOpenAIClient.vectorStores.files.list.mockResolvedValueOnce(firstPage)

        const result = await openaiAssistantsService.getSingleOpenaiAssistant('credential-1', 'asst-1', 'workspace-owner')

        expect(firstPage.getNextPage).toHaveBeenCalledTimes(1)
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledWith('file-page-1')
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledWith('file-page-2')
        expect(result.tool_resources.file_search.files).toEqual([{ id: 'file-page-1' }, { id: 'file-page-2' }])
        expect(result.tool_resources.file_search.vector_store_object).toEqual({ id: 'vs-1', name: 'Knowledge Base' })
    })

    it('rejects a malformed vector store files page instead of reporting an empty file set', async () => {
        mockOpenAIClient.beta.assistants.retrieve.mockResolvedValueOnce({
            id: 'asst-1',
            tool_resources: {
                file_search: {
                    vector_store_ids: ['vs-1']
                }
            }
        })
        mockOpenAIClient.vectorStores.files.list.mockResolvedValueOnce({ data: null })

        await expect(openaiAssistantsService.getSingleOpenaiAssistant('credential-1', 'asst-1', 'workspace-owner')).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to load OpenAI Assistant details'
        })
        expect(mockOpenAIClient.files.retrieve).not.toHaveBeenCalled()
        expect(mockOpenAIClient.vectorStores.retrieve).not.toHaveBeenCalled()
    })

    it('fails the whole assistant detail response with a fixed error when an associated file is missing', async () => {
        const assistant = {
            id: 'asst-1',
            tool_resources: {
                code_interpreter: {
                    file_ids: ['file-present', 'file-missing']
                }
            }
        }
        mockOpenAIClient.beta.assistants.retrieve.mockResolvedValueOnce(assistant)
        mockOpenAIClient.files.retrieve
            .mockResolvedValueOnce({ id: 'file-present' })
            .mockRejectedValueOnce(new Error('404 provider body contains secret'))

        await expect(openaiAssistantsService.getSingleOpenaiAssistant('credential-1', 'asst-1', 'workspace-owner')).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to load OpenAI Assistant details'
        })
        expect((assistant.tool_resources.code_interpreter as any).files).toBeUndefined()
    })

    it('keeps client errors fixed when cleanup and remote compensation both fail', async () => {
        mockOpenAIClient.files.create.mockResolvedValueOnce({ id: 'remote-file-1' }).mockRejectedValueOnce(new Error('provider raw body'))
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('/tmp/private-path'))
        mockOpenAIClient.files.delete.mockRejectedValueOnce(new Error('compensation raw body'))

        await expect(
            openaiAssistantsService.uploadFilesToAssistant(
                'credential-1',
                [
                    { filePath: '/tmp/private-one', fileName: 'one.txt' },
                    { filePath: '/tmp/private-two', fileName: 'two.txt' }
                ],
                'workspace-owner'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to finalize OpenAI Assistant file upload'
        })

        const serializedLogs = JSON.stringify(mockLoggerError.mock.calls)
        expect(serializedLogs).toContain('openai_assistant_upload_local_cleanup_failed')
        expect(serializedLogs).toContain('openai_assistant_upload_remote_compensation_failed')
        expect(serializedLogs).not.toContain('/tmp/private')
        expect(serializedLogs).not.toContain('raw body')
    })

    it('counts an unconfirmed Provider compensation result as a safe aggregate failure', async () => {
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('/tmp/private-upload'))
        mockOpenAIClient.files.delete.mockResolvedValueOnce({ deleted: false })

        await expect(
            openaiAssistantsService.uploadFilesToAssistant(
                'credential-1',
                [{ filePath: '/tmp/private-upload', fileName: 'one.txt' }],
                'workspace-owner'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to finalize OpenAI Assistant file upload'
        })

        expect(mockLoggerError).toHaveBeenCalledWith('openai_assistant_upload_remote_compensation_failed', {
            failedCount: 1,
            totalCount: 1
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('/tmp/private-upload')
    })

    it('lets local cleanup failure override a scoped credential error with a fixed 500', async () => {
        credentialRepository.findOneBy.mockResolvedValue(null)
        sharedRepository.findOneBy.mockResolvedValue(null)
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('/tmp/private-upload'))

        await expect(
            openaiAssistantsService.uploadFilesToAssistant(
                'credential-1',
                [{ filePath: '/tmp/private-upload', fileName: 'one.txt' }],
                'workspace-other'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to finalize OpenAI Assistant file upload'
        })

        expect(mockOpenAI).not.toHaveBeenCalled()
        expect(mockLoggerError).toHaveBeenCalledWith('openai_assistant_upload_local_cleanup_failed', {
            failedCount: 1,
            totalCount: 1
        })
    })

    it('lets an unconfirmed remote compensation override the original provider failure with a fixed 500', async () => {
        mockOpenAIClient.files.create.mockResolvedValueOnce({ id: 'remote-file-1' }).mockRejectedValueOnce(new Error('provider raw body'))
        mockOpenAIClient.files.delete.mockResolvedValueOnce({ deleted: false })

        await expect(
            openaiAssistantsService.uploadFilesToAssistant(
                'credential-1',
                [
                    { filePath: '/tmp/upload-one', fileName: 'one.txt' },
                    { filePath: '/tmp/upload-two', fileName: 'two.txt' }
                ],
                'workspace-owner'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to finalize OpenAI Assistant file upload'
        })

        expect(mockLoggerError).toHaveBeenCalledWith('openai_assistant_upload_remote_compensation_failed', {
            failedCount: 1,
            totalCount: 1
        })
    })
})
