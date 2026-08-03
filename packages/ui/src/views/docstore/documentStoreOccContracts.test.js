import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (fileName) => readFileSync(resolve(__dirname, fileName), 'utf8')
const between = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))

describe('document store optimistic concurrency UI contracts', () => {
    it('chains the loader save token into process without consuming a queue acceptance token', () => {
        const source = read('LoaderConfigPreviewChunks.jsx')

        expect(source).toMatch(/savedVersionToken[\s\S]*processLoader\(config, saveResp\.data\.id, savedVersionToken\)/)
        expect(source).not.toContain('acceptedVersionToken')
        expect(source).toContain("navigate('/document-stores/' + storeId)")
    })

    it('keeps document-store deletion local and does not auto-run an external vector side effect', () => {
        const detail = read('DocumentStoreDetail.jsx')
        const list = read('index.jsx')
        const dialog = read('DeleteDocStoreDialog.jsx')

        expect(detail).not.toContain('deleteVectorStoreDataFromStore(')
        expect(detail).toMatch(
            /const versionToken = requireDocumentStoreVersionToken\(documentStore\)[\s\S]*deleteDocumentStore\(storeId, versionToken\)/
        )
        expect(detail).toContain('外部向量服务中的数据未自动清理')
        expect(detail).not.toContain('外部向量 Provider 数据')
        expect(list).not.toContain('此操作还会删除向量数据库中的实际数据')
        expect(list).not.toContain('外部向量 Provider 数据')
        expect(dialog).toContain('不会删除外部向量服务中的数据')
        expect(dialog).toContain('两步无法保证原子性')
        expect(list).toMatch(
            /isDocumentStoreVersionConflict\(error\)[\s\S]*setShowDeleteDocStoreDialog\(false\)[\s\S]*setDeleteDocStoreDialogProps\(\{\}\)/
        )
        expect(list).not.toContain('setDeleteDocStoreDialogProps((current) => ({ ...current, versionToken: latestVersionToken }))')
    })

    it('locks stale drafts until the user explicitly reloads latest values', () => {
        const editDialog = read('AddDocStoreDialog.jsx')
        const vectorConfig = read('VectorStoreConfigure.jsx')
        const vectorQuery = read('VectorStoreQuery.jsx')
        const chunks = read('ShowStoredChunks.jsx')
        const expandedChunk = read('ExpandedChunkDialog.jsx')
        const addConflictBranch = between(editDialog, 'if (isDocumentStoreVersionConflict(error))', 'const key =')
        const vectorConflictHandler = between(vectorConfig, 'const enterVersionConflict', 'const reloadLatestValues')
        const queryConflictBranch = between(vectorQuery, 'if (isDocumentStoreVersionConflict(error))', 'enqueueSnackbar({')

        expect(editDialog).toMatch(
            /isDocumentStoreVersionConflict\(error\)[\s\S]*setVersionToken\(undefined\)[\s\S]*setHasVersionConflict\(true\)/
        )
        expect(addConflictBranch).not.toContain('getSpecificDocumentStore')
        expect(vectorConflictHandler).not.toContain('getSpecificDocumentStore')
        expect(queryConflictBranch).not.toContain('getSpecificDocumentStore')
        expect(editDialog).toContain('disabled={isSubmitting || hasVersionConflict || !documentStoreName.trim()}')
        expect(editDialog).toContain('重新载入最新值')
        expect(editDialog).toContain('getSpecificDocumentStore(docStoreId)')
        expect(editDialog).toContain('const latestVersionToken = requireDocumentStoreVersionToken(latestResponse.data)')
        expect(editDialog).toContain('setVersionToken(latestVersionToken)')

        for (const source of [vectorConfig, vectorQuery]) {
            expect(source).toContain('setHasVersionConflict(true)')
            expect(source).toContain('versionToken: undefined')
            expect(source).toContain('重新载入最新值')
            expect(source).toContain('window.location.reload()')
        }
        expect(chunks).toContain('setHasVersionConflict(true)')
        expect(chunks).toContain('setVersionToken(undefined)')
        expect(chunks).toContain('window.location.reload()')
        expect(expandedChunk).toContain('重新载入最新值')
        expect(vectorConfig).toContain('disabled={hasVersionConflict}')
        expect(vectorQuery).toContain('disabled={hasVersionConflict}')
        expect(chunks).not.toMatch(/isDocumentStoreVersionConflict\(error\)[\s\S]{0,160}getChunksApi\.request/)
    })

    it('documents If-Match with a placeholder instead of a live version token', () => {
        const source = read('DocStoreAPIDialog.jsx')

        expect(source).toContain('const versionToken = \'"<version-token-from-document-store-GET>"\'')
        expect(source.match(/If-Match/g)).toHaveLength(6)
        expect(source).not.toContain('dialogProps?.versionToken')
        expect(source.match(/f"Bearer \{API_KEY\}"/g)).toHaveLength(2)
        expect(source).not.toContain('BEARER_TOKEN')
    })
})
