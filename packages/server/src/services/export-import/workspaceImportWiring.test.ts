import fs from 'fs'
import path from 'path'

describe('workspace import transactional wiring', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

    it('scrubs credential bindings, then normalizes and budgets the payload before opening a query runner', () => {
        const scrub = source.indexOf('sanitizeWorkspaceImportForRebinding(')
        const normalize = source.indexOf('normalizeWorkspaceImportForCreate(')
        expect(scrub).toBeGreaterThan(-1)
        expect(scrub).toBeLessThan(normalize)
        expect(normalize).toBeGreaterThan(-1)
        expect(source.indexOf('normalizeWorkspaceImportForCreate(')).toBeLessThan(source.indexOf('.createQueryRunner()'))
        expect(source).not.toContain('sanitizeNullBytes(importData)')
        expect(source).not.toContain('reduceSpaceForChatflowFlowData')
        expect(source).not.toContain('.replaceAll(')
    })

    it('starts one transaction before relation preflights and all insert-only persistence', () => {
        const transaction = source.indexOf('await queryRunner.startTransaction()')
        const documentStorePreflight = source.indexOf('preflightDocumentStoreReferencesForImport(')
        const relationPreflight = source.indexOf('preflightWorkspaceImportRelations(')
        const firstInsert = source.indexOf('insertWorkspaceImportBatch(queryRunner.manager, ChatFlow')
        const commit = source.indexOf('await queryRunner.commitTransaction()')

        expect(transaction).toBeGreaterThan(-1)
        expect(transaction).toBeLessThan(documentStorePreflight)
        expect(documentStorePreflight).toBeLessThan(relationPreflight)
        expect(relationPreflight).toBeLessThan(firstInsert)
        expect(firstInsert).toBeLessThan(commit)
        expect(source).not.toContain('queryRunner.manager.save(')
    })

    it('forces document stores into the active workspace before strict sanitization', () => {
        expect(source).toMatch(
            /sanitizeDocumentStoresForImport\([\s\S]*?\.map\(\(documentStore\) => \(\{ \.\.\.documentStore, workspaceId: activeWorkspaceId \}\)\)[\s\S]*?\)/
        )
    })
})
