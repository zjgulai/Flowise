import { deleteAssistantFileSearchFile } from './assistantFileDeletion'

describe('OpenAI assistant file-search deletion', () => {
    const assistantScope = { id: 'assistant-1', generation: 1 }
    const vectorStoreGeneration = 3
    const toolResources = {
        file_search: {
            vector_store_ids: ['vector-store-1'],
            files: [
                { id: 'file-1', filename: 'first.txt' },
                { id: 'file-2', filename: 'second.txt' }
            ],
            vector_store_object: { id: 'vector-store-1' }
        }
    }

    const callDeletion = (overrides = {}) => {
        const commitToolResources = jest.fn()
        const deleteFiles = jest.fn().mockResolvedValue({ data: { deletedFileIds: ['file-1'], count: 1 } })
        const requestConfig = { signal: new AbortController().signal }
        const input = {
            fileId: 'file-1',
            toolResources,
            credential: 'credential-1',
            assistantScope,
            vectorStoreGeneration,
            requestConfig,
            isAssistantScopeCurrent: () => true,
            isVectorStoreGenerationCurrent: () => true,
            deleteFiles,
            getCurrentToolResources: () => toolResources,
            commitToolResources,
            ...overrides
        }

        return { result: deleteAssistantFileSearchFile(input), commitToolResources, deleteFiles: input.deleteFiles, requestConfig }
    }

    it('keeps local state unchanged when the remote deletion fails', async () => {
        const { result, commitToolResources, deleteFiles, requestConfig } = callDeletion({
            deleteFiles: jest.fn().mockRejectedValue(new Error('remote details must stay private'))
        })

        await expect(result).rejects.toThrow('remote details must stay private')
        expect(deleteFiles).toHaveBeenCalledWith('vector-store-1', 'credential-1', { file_ids: ['file-1'] }, requestConfig)
        expect(commitToolResources).not.toHaveBeenCalled()
    })

    it('commits local state only after the response confirms the exact file id', async () => {
        const { result, commitToolResources, deleteFiles } = callDeletion()

        await expect(result).resolves.toBe(true)
        expect(deleteFiles.mock.invocationCallOrder[0]).toBeLessThan(commitToolResources.mock.invocationCallOrder[0])
        expect(commitToolResources).toHaveBeenCalledWith({
            file_search: {
                vector_store_ids: ['vector-store-1'],
                files: [{ id: 'file-2', filename: 'second.txt' }],
                vector_store_object: { id: 'vector-store-1' }
            }
        })
    })

    it.each([
        ['has no payload', undefined],
        ['contains a truthy legacy payload', true],
        ['reports a count without ids', { count: 1 }],
        ['confirms a different id', { deletedFileIds: ['file-2'], count: 1 }],
        ['has an inconsistent count', { deletedFileIds: ['file-1'], count: 0 }],
        ['contains extra ids', { deletedFileIds: ['file-1', 'file-2'], count: 2 }]
    ])('returns false without a local commit when the response %s', async (_case, responseData) => {
        const { result, commitToolResources } = callDeletion({
            deleteFiles: jest.fn().mockResolvedValue({ data: responseData })
        })

        await expect(result).resolves.toBe(false)
        expect(commitToolResources).not.toHaveBeenCalled()
    })

    it.each([
        ['assistant scope is stale', { isAssistantScopeCurrent: () => false }],
        ['vector-store generation is stale', { isVectorStoreGenerationCurrent: () => false }],
        [
            'file is absent locally',
            { toolResources: { file_search: { ...toolResources.file_search, files: [{ id: 'file-2', filename: 'second.txt' }] } } }
        ]
    ])('does not start the remote mutation when the %s', async (_case, overrides) => {
        const { result, commitToolResources, deleteFiles } = callDeletion(overrides)

        await expect(result).resolves.toBe(false)
        expect(deleteFiles).not.toHaveBeenCalled()
        expect(commitToolResources).not.toHaveBeenCalled()
    })

    it.each(['assistant', 'vector'])('does not commit after the %s generation changes while the request is pending', async (kind) => {
        let resolveDeletion
        let assistantCurrent = true
        let vectorCurrent = true
        const { result, commitToolResources } = callDeletion({
            deleteFiles: jest.fn(
                () =>
                    new Promise((resolve) => {
                        resolveDeletion = resolve
                    })
            ),
            isAssistantScopeCurrent: () => assistantCurrent,
            isVectorStoreGenerationCurrent: () => vectorCurrent
        })

        if (kind === 'assistant') assistantCurrent = false
        else vectorCurrent = false
        resolveDeletion({ data: { deletedFileIds: ['file-1'], count: 1 } })

        await expect(result).resolves.toBe(false)
        expect(commitToolResources).not.toHaveBeenCalled()
    })

    it('does not commit when the current vector store changed before completion', async () => {
        const changedResources = {
            file_search: { vector_store_ids: ['vector-store-2'], files: [], vector_store_object: { id: 'vector-store-2' } }
        }
        const { result, commitToolResources } = callDeletion({ getCurrentToolResources: () => changedResources })

        await expect(result).resolves.toBe(false)
        expect(commitToolResources).not.toHaveBeenCalled()
    })
})
