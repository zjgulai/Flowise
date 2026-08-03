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

jest.mock('../../utils', () => ({ decryptCredentialData: jest.fn() }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('flowise-components', () => ({
    getFileFromUpload: jest.fn(),
    removeSpecificFileFromUpload: jest.fn()
}))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { error: jest.fn() }
}))

const mockAssertOpenAIAssistantResourceCreationAllowed = jest.fn()
const mockAssertOpenAIAssistantResourceDestructionAllowed = jest.fn()

jest.mock('../assistants/legacyPolicy', () => ({
    assertOpenAIAssistantResourceCreationAllowed: () => mockAssertOpenAIAssistantResourceCreationAllowed(),
    assertOpenAIAssistantResourceDestructionAllowed: () => mockAssertOpenAIAssistantResourceDestructionAllowed()
}))

import openaiAssistantsVectorStoreService from '.'

const mockOpenAI = OpenAI as unknown as jest.Mock
const mockDecryptCredentialData = decryptCredentialData as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const mockGetFileFromUpload = getFileFromUpload as jest.Mock
const mockRemoveSpecificFileFromUpload = removeSpecificFileFromUpload as jest.Mock
const mockToFile = OpenAI.toFile as jest.Mock
const mockLoggerError = logger.error as jest.Mock

const credentialRepository = { findOneBy: jest.fn() }
const sharedRepository = { findOneBy: jest.fn() }

const mockOpenAIClient = {
    vectorStores: {
        retrieve: jest.fn(),
        list: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        files: {
            list: jest.fn(),
            delete: jest.fn()
        },
        fileBatches: {
            createAndPoll: jest.fn()
        }
    },
    files: {
        create: jest.fn(),
        retrieve: jest.fn(),
        delete: jest.fn()
    }
}

describe('OpenAI Assistant vector store service', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        credentialRepository.findOneBy.mockResolvedValue({
            id: 'credential-1',
            workspaceId: 'workspace-1',
            encryptedData: 'encrypted'
        } as Credential)
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
        mockDecryptCredentialData.mockResolvedValue({ openAIApiKey: 'test-key' })
        mockOpenAI.mockImplementation(() => mockOpenAIClient)
        mockOpenAIClient.vectorStores.retrieve.mockResolvedValue({ id: 'vs-1' })
        mockOpenAIClient.vectorStores.list.mockResolvedValue({ data: [{ id: 'vs-1' }] })
        mockOpenAIClient.vectorStores.create.mockResolvedValue({ id: 'vs-created' })
        mockOpenAIClient.vectorStores.update.mockImplementation(async () => ({ id: 'vs-1', name: 'Knowledge Base' }))
        mockOpenAIClient.vectorStores.delete.mockResolvedValue({ id: 'vs-1', deleted: true })
        mockOpenAIClient.vectorStores.files.list.mockResolvedValue({ data: [] })
        mockOpenAIClient.vectorStores.files.delete.mockResolvedValue({ deleted: true })
        mockOpenAIClient.vectorStores.fileBatches.createAndPoll.mockResolvedValue({
            status: 'completed',
            file_counts: { completed: 1 }
        })
        mockOpenAIClient.files.create.mockResolvedValue({ id: 'file-1' })
        mockOpenAIClient.files.retrieve.mockImplementation(async (fileId) => ({ id: fileId }))
        mockOpenAIClient.files.delete.mockResolvedValue({ deleted: true })
        mockGetFileFromUpload.mockResolvedValue(Buffer.from('file'))
        mockToFile.mockResolvedValue({ name: 'file.txt' })
        mockRemoveSpecificFileFromUpload.mockResolvedValue(undefined)
        mockAssertOpenAIAssistantResourceCreationAllowed.mockImplementation(() => undefined)
        mockAssertOpenAIAssistantResourceDestructionAllowed.mockImplementation(() => undefined)
    })

    it('replaces a previous one-file result with an explicit empty files array', async () => {
        mockOpenAIClient.vectorStores.files.list.mockResolvedValueOnce({ data: [{ id: 'file-1' }] }).mockResolvedValueOnce({ data: [] })

        const first = await openaiAssistantsVectorStoreService.updateAssistantVectorStore(
            'credential-1',
            'vs-1',
            { name: 'Knowledge Base' },
            'workspace-1'
        )
        expect((first as any).files).toEqual([{ id: 'file-1' }])

        const second = await openaiAssistantsVectorStoreService.updateAssistantVectorStore(
            'credential-1',
            'vs-1',
            { name: 'Knowledge Base' },
            'workspace-1'
        )
        expect((second as any).files).toEqual([])
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledTimes(1)
    })

    it('returns vector stores from every Provider page', async () => {
        const secondPage = { data: [{ id: 'vs-2' }], hasNextPage: () => false }
        const firstPage = {
            data: [{ id: 'vs-1' }],
            hasNextPage: () => true,
            getNextPage: jest.fn().mockResolvedValue(secondPage)
        }
        mockOpenAIClient.vectorStores.list.mockResolvedValueOnce(firstPage)

        await expect(openaiAssistantsVectorStoreService.listAssistantVectorStore('credential-1', 'workspace-1')).resolves.toEqual([
            { id: 'vs-1' },
            { id: 'vs-2' }
        ])
        expect(firstPage.getNextPage).toHaveBeenCalledTimes(1)
    })

    it('rejects duplicate vector store IDs across Provider pages', async () => {
        const secondPage = { data: [{ id: 'vs-1' }], hasNextPage: () => false }
        mockOpenAIClient.vectorStores.list.mockResolvedValueOnce({
            data: [{ id: 'vs-1' }],
            hasNextPage: () => true,
            getNextPage: jest.fn().mockResolvedValue(secondPage)
        })

        await expect(openaiAssistantsVectorStoreService.listAssistantVectorStore('credential-1', 'workspace-1')).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to list OpenAI Assistant vector stores'
        })
    })

    it('retrieves vector store files from every Provider page', async () => {
        const secondPage = { data: [{ id: 'file-2' }], hasNextPage: () => false }
        const firstPage = {
            data: [{ id: 'file-1' }],
            hasNextPage: () => true,
            getNextPage: jest.fn().mockResolvedValue(secondPage)
        }
        mockOpenAIClient.vectorStores.files.list.mockResolvedValueOnce(firstPage)

        const result = await openaiAssistantsVectorStoreService.updateAssistantVectorStore(
            'credential-1',
            'vs-1',
            { name: 'Knowledge Base' },
            'workspace-1'
        )

        expect(firstPage.getNextPage).toHaveBeenCalledTimes(1)
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledWith('file-1')
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledWith('file-2')
        expect((result as any).files).toEqual([{ id: 'file-1' }, { id: 'file-2' }])
    })

    it('rejects duplicate IDs across pages with a fixed error', async () => {
        const secondPage = { data: [{ id: 'file-1' }], hasNextPage: () => false }
        mockOpenAIClient.vectorStores.files.list.mockResolvedValueOnce({
            data: [{ id: 'file-1' }],
            hasNextPage: () => true,
            getNextPage: jest.fn().mockResolvedValue(secondPage)
        })

        await expect(
            openaiAssistantsVectorStoreService.updateAssistantVectorStore('credential-1', 'vs-1', { name: 'Knowledge Base' }, 'workspace-1')
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to load vector store files'
        })
        expect(mockOpenAIClient.files.retrieve).not.toHaveBeenCalled()
    })

    it('rejects a malformed files page instead of reporting an empty vector store file set', async () => {
        mockOpenAIClient.vectorStores.files.list.mockResolvedValueOnce({ data: null })

        await expect(
            openaiAssistantsVectorStoreService.updateAssistantVectorStore('credential-1', 'vs-1', { name: 'Knowledge Base' }, 'workspace-1')
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to load vector store files'
        })
        expect(mockOpenAIClient.files.retrieve).not.toHaveBeenCalled()
    })

    it('rejects direct vector resource creation before credential or Provider access', async () => {
        mockAssertOpenAIAssistantResourceCreationAllowed.mockImplementationOnce(() => {
            throw new InternalFlowiseError(
                StatusCodes.GONE,
                'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
            )
        })
        await expect(
            openaiAssistantsVectorStoreService.createAssistantVectorStore('credential-1', { name: 'Legacy vector store' }, 'workspace-1')
        ).rejects.toMatchObject({
            statusCode: StatusCodes.GONE,
            message: 'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
        })

        expect(credentialRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockDecryptCredentialData).not.toHaveBeenCalled()
        expect(mockOpenAI).not.toHaveBeenCalled()
    })

    it('rejects direct vector uploads before filesystem, credential, or Provider access', async () => {
        mockAssertOpenAIAssistantResourceCreationAllowed.mockImplementationOnce(() => {
            throw new InternalFlowiseError(
                StatusCodes.GONE,
                'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
            )
        })
        await expect(
            openaiAssistantsVectorStoreService.uploadFilesToAssistantVectorStore(
                'credential-1',
                'vs-1',
                [
                    { filePath: '/tmp/vector-one', fileName: 'one.txt' },
                    { filePath: '/tmp/vector-two', fileName: 'two.txt' }
                ],
                'workspace-1'
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

    it.each([
        [
            'vector store deletion',
            () => openaiAssistantsVectorStoreService.deleteAssistantVectorStore('credential-1', 'vs-1', 'workspace-1')
        ],
        [
            'vector file deletion',
            () => openaiAssistantsVectorStoreService.deleteFilesFromAssistantVectorStore('credential-1', 'vs-1', ['file-1'], 'workspace-1')
        ]
    ])('rejects direct destructive %s before credential or Provider access', async (_name, operation) => {
        mockAssertOpenAIAssistantResourceDestructionAllowed.mockImplementationOnce(() => {
            throw new InternalFlowiseError(
                StatusCodes.GONE,
                'OpenAI Assistants API is deprecated and destructive OpenAI Assistant resource cleanup is disabled'
            )
        })

        await expect(operation()).rejects.toMatchObject({
            statusCode: StatusCodes.GONE,
            message: 'OpenAI Assistants API is deprecated and destructive OpenAI Assistant resource cleanup is disabled'
        })
        expect(credentialRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockDecryptCredentialData).not.toHaveBeenCalled()
        expect(mockOpenAI).not.toHaveBeenCalled()
    })

    it('cleans local files after a successful upload without compensating Provider files', async () => {
        const result = await openaiAssistantsVectorStoreService.uploadFilesToAssistantVectorStore(
            'credential-1',
            'vs-1',
            [{ filePath: '/tmp/vector-one', fileName: 'one.txt' }],
            'workspace-1'
        )

        expect(result).toEqual([{ id: 'file-1' }])
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/vector-one')
        expect(mockOpenAIClient.files.delete).not.toHaveBeenCalled()
    })

    it('cleans every local file and compensates a partial Provider upload failure', async () => {
        mockOpenAIClient.files.create.mockResolvedValueOnce({ id: 'remote-file-1' }).mockRejectedValueOnce(new Error('raw provider body'))

        await expect(
            openaiAssistantsVectorStoreService.uploadFilesToAssistantVectorStore(
                'credential-1',
                'vs-1',
                [
                    { filePath: '/tmp/vector-one', fileName: 'one.txt' },
                    { filePath: '/tmp/vector-two', fileName: 'two.txt' }
                ],
                'workspace-1'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to finalize OpenAI Assistant vector store file upload'
        })

        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledTimes(2)
        expect(mockOpenAIClient.files.delete).toHaveBeenCalledWith('remote-file-1')
        expect(mockOpenAIClient.vectorStores.fileBatches.createAndPoll).not.toHaveBeenCalled()
    })

    it('compensates uploaded Provider files when a batch is incomplete', async () => {
        mockOpenAIClient.vectorStores.fileBatches.createAndPoll.mockResolvedValueOnce({
            status: 'completed',
            file_counts: { completed: 0 }
        })

        await expect(
            openaiAssistantsVectorStoreService.uploadFilesToAssistantVectorStore(
                'credential-1',
                'vs-1',
                [{ filePath: '/tmp/vector-one', fileName: 'one.txt' }],
                'workspace-1'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to attach OpenAI Assistant vector store files'
        })

        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/vector-one')
        expect(mockOpenAIClient.files.delete).toHaveBeenCalledWith('file-1')
    })

    it('treats unconfirmed Provider compensation as a logged failure without leaking details', async () => {
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('private path /tmp/vector-one'))
        mockOpenAIClient.files.delete.mockResolvedValueOnce({ deleted: false })

        await expect(
            openaiAssistantsVectorStoreService.uploadFilesToAssistantVectorStore(
                'credential-1',
                'vs-1',
                [{ filePath: '/tmp/vector-one', fileName: 'one.txt' }],
                'workspace-1'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to finalize OpenAI Assistant vector store file upload'
        })

        expect(mockLoggerError).toHaveBeenCalledWith('openai_vector_store_upload_local_cleanup_failed', {
            failedCount: 1,
            totalCount: 1
        })
        expect(mockLoggerError).toHaveBeenCalledWith('openai_vector_store_upload_remote_compensation_failed', {
            failedCount: 1,
            totalCount: 1
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('/tmp/vector-one')
    })

    it('rejects a cross-workspace credential before Provider access and still cleans local files', async () => {
        credentialRepository.findOneBy.mockResolvedValue(null)
        sharedRepository.findOneBy.mockResolvedValue(null)

        await expect(
            openaiAssistantsVectorStoreService.uploadFilesToAssistantVectorStore(
                'credential-secret',
                'vs-1',
                [{ filePath: '/tmp/vector-one', fileName: 'one.txt' }],
                'workspace-attacker'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND,
            message: 'Credential not found'
        })

        expect(mockDecryptCredentialData).not.toHaveBeenCalled()
        expect(mockOpenAI).not.toHaveBeenCalled()
        expect(mockRemoveSpecificFileFromUpload).toHaveBeenCalledWith('/tmp/vector-one')
    })

    it('lets local cleanup failure override a scoped credential error with a fixed finalization error', async () => {
        credentialRepository.findOneBy.mockResolvedValue(null)
        sharedRepository.findOneBy.mockResolvedValue(null)
        mockRemoveSpecificFileFromUpload.mockRejectedValueOnce(new Error('private path /tmp/vector-one'))

        await expect(
            openaiAssistantsVectorStoreService.uploadFilesToAssistantVectorStore(
                'credential-secret',
                'vs-1',
                [{ filePath: '/tmp/vector-one', fileName: 'one.txt' }],
                'workspace-attacker'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to finalize OpenAI Assistant vector store file upload'
        })

        expect(mockLoggerError).toHaveBeenCalledWith('openai_vector_store_upload_local_cleanup_failed', {
            failedCount: 1,
            totalCount: 1
        })
    })

    it('lets failed Provider compensation override the original upload error', async () => {
        mockOpenAIClient.files.create.mockResolvedValueOnce({ id: 'remote-file-1' }).mockRejectedValueOnce(new Error('provider secret'))
        mockOpenAIClient.files.delete.mockRejectedValueOnce(new Error('provider compensation secret'))

        await expect(
            openaiAssistantsVectorStoreService.uploadFilesToAssistantVectorStore(
                'credential-1',
                'vs-1',
                [
                    { filePath: '/tmp/vector-one', fileName: 'one.txt' },
                    { filePath: '/tmp/vector-two', fileName: 'two.txt' }
                ],
                'workspace-1'
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to finalize OpenAI Assistant vector store file upload'
        })

        expect(mockLoggerError).toHaveBeenCalledWith('openai_vector_store_upload_remote_compensation_failed', {
            failedCount: 1,
            totalCount: 1
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('provider compensation secret')
    })

    it('does not expose raw Provider errors from vector store operations', async () => {
        mockOpenAIClient.vectorStores.retrieve.mockRejectedValueOnce(new Error('provider token secret'))

        let caught: unknown
        try {
            await openaiAssistantsVectorStoreService.getAssistantVectorStore('credential-1', 'vs-secret', 'workspace-1')
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(InternalFlowiseError)
        expect((caught as InternalFlowiseError).statusCode).toBe(StatusCodes.INTERNAL_SERVER_ERROR)
        expect((caught as Error).message).toBe('Unable to load OpenAI Assistant vector store')
        expect((caught as Error).message).not.toContain('provider token secret')
        expect((caught as Error).message).not.toContain('vs-secret')
    })
})
