import fs from 'fs'
import path from 'path'

describe('document store credential-backed node option contracts', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

    it('passes workspaceId in every local node options object that exposes databaseEntities', () => {
        const optionBlocks = [...source.matchAll(/const options: ICommonObject = \{([\s\S]*?)\n\s*\}/g)]
            .map((match) => match[1])
            .filter((block) => block.includes('databaseEntities'))

        expect(optionBlocks).toHaveLength(5)
        for (const block of optionBlocks) expect(block).toContain('workspaceId')
    })

    it('binds vector store queries to the active workspace before provider initialization', () => {
        const queryBlock = source.slice(source.indexOf('const queryVectorStore'), source.indexOf('const _createEmbeddingsObject'))

        expect(queryBlock).toMatch(/findOneBy\(\{\s*id: data\.storeId,\s*workspaceId\s*\}\)/)
        expect(queryBlock.indexOf('findOneBy')).toBeLessThan(queryBlock.indexOf('_createEmbeddingsObject'))
        expect(queryBlock).toContain('entity.status !== DocumentStoreStatus.UPSERTED')
        expect(queryBlock.indexOf('entity.status !== DocumentStoreStatus.UPSERTED')).toBeLessThan(
            queryBlock.indexOf('_createEmbeddingsObject')
        )
    })

    it('keeps queued vector upserts credential-scoped inside the worker path', () => {
        const workerBlock = source.slice(
            source.indexOf('const _insertIntoVectorStoreWorkerThread'),
            source.indexOf('const getEmbeddingProviders')
        )

        expect(source).toMatch(/const validateResolvedDocumentVectorComponents[\s\S]*findOneBy\(\{ id: storeId, workspaceId \}\)/)
        expect(workerBlock).toMatch(/validateResolvedDocumentVectorComponents\([\s\S]*data\.storeId[\s\S]*workspaceId/)
        expect(workerBlock).toMatch(/const options: ICommonObject = \{[\s\S]*workspaceId[\s\S]*\}/)
    })

    it('awaits loader storage cleanup and logs only aggregate failures', () => {
        expect(source).not.toMatch(/\.map\(async \(file: IDocumentStoreLoaderFile\)/)
        expect(source).not.toContain('console.error(error)')
        expect(source).toContain('await removeDocumentStoreLoaderFiles(')
        expect(source).toContain("logger.error(event, { failedCount: accountingFailureCount, phase: 'accounting' })")
        expect(source).toContain("logger.error(event, { failedCount: 1, phase: 'storage' })")
        expect(source).not.toContain("failDocumentStoreStorageCleanup(event, 'accounting')")
    })
})
