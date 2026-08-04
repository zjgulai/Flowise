export {}

const mockHandleEscapeCharacters = jest.fn((value: string) => value)

jest.mock('../../../src', () => ({ handleEscapeCharacters: mockHandleEscapeCharacters }))

const { nodeClass: DocStoreDocumentLoader } = require('./DocStoreLoader')

const makeHarness = (store: Record<string, unknown> | null = null) => {
    const storeRepository = {
        findOneBy: jest.fn(async ({ id, workspaceId }: { id: string; workspaceId: string }) =>
            store?.id === id && store?.workspaceId === workspaceId ? store : null
        )
    }
    const chunkRepository = {
        find: jest.fn().mockResolvedValue([{ pageContent: 'Scoped content', metadata: '{"source":"fixture"}' }])
    }
    const appDataSource = {
        getRepository: jest.fn((entity: string) => (entity === 'DocumentStoreEntity' ? storeRepository : chunkRepository))
    }
    return {
        storeRepository,
        chunkRepository,
        options: {
            workspaceId: 'workspace-a',
            appDataSource,
            databaseEntities: {
                DocumentStore: 'DocumentStoreEntity',
                DocumentStoreFileChunk: 'DocumentStoreFileChunkEntity'
            }
        }
    }
}

describe('Document Store loader runtime tenant boundary', () => {
    beforeEach(() => jest.clearAllMocks())

    it.each([undefined, '', '   '])('rejects a missing workspace before any repository access (%p)', async (workspaceId) => {
        const harness = makeHarness()
        const node = new DocStoreDocumentLoader()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', { ...harness.options, workspaceId })).rejects.toThrow(
            'Document Store workspace context is required'
        )
        expect(harness.options.appDataSource.getRepository).not.toHaveBeenCalled()
        expect(harness.chunkRepository.find).not.toHaveBeenCalled()
    })

    it('does not read chunks when the selected parent is absent from the active workspace', async () => {
        const harness = makeHarness({ id: 'store-a', workspaceId: 'workspace-b', status: 'SYNC' })
        const node = new DocStoreDocumentLoader()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', harness.options)).rejects.toThrow(
            'Document Store is unavailable'
        )
        expect(harness.storeRepository.findOneBy).toHaveBeenCalledWith({ id: 'store-a', workspaceId: 'workspace-a' })
        expect(harness.chunkRepository.find).not.toHaveBeenCalled()
    })

    it('does not read chunks from a same-workspace store in the wrong lifecycle state', async () => {
        const harness = makeHarness({ id: 'store-a', workspaceId: 'workspace-a', status: 'UPSERTED' })
        const node = new DocStoreDocumentLoader()

        await expect(node.init({ inputs: { selectedStore: 'store-a' } }, '', harness.options)).rejects.toThrow(
            'Document Store is unavailable'
        )
        expect(harness.chunkRepository.find).not.toHaveBeenCalled()
    })

    it('loads chunks only after a same-workspace synchronized parent is verified', async () => {
        const harness = makeHarness({ id: 'store-a', workspaceId: 'workspace-a', status: 'SYNC' })
        const node = new DocStoreDocumentLoader()

        const result = await node.init({ inputs: { selectedStore: ' store-a ' }, outputs: { output: 'document' } }, '', harness.options)

        expect(harness.storeRepository.findOneBy).toHaveBeenCalledWith({ id: 'store-a', workspaceId: 'workspace-a' })
        expect(harness.chunkRepository.find).toHaveBeenCalledWith({ where: { storeId: 'store-a' } })
        expect(result).toEqual([expect.objectContaining({ pageContent: 'Scoped content', metadata: { source: 'fixture' } })])
    })
})
