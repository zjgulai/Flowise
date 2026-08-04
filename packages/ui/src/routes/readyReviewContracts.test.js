import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (relativePath) => readFileSync(resolve(__dirname, relativePath), 'utf8')

describe('Ready review remediation contracts', () => {
    it('shows safe Chinese feedback when tool import or credential loading fails', () => {
        const tools = read('../views/tools/index.jsx')
        const credentials = read('../views/canvas/CredentialInputHandler.jsx')

        for (const source of [tools, credentials]) {
            expect(source).toContain("import { useSnackbar } from 'notistack'")
            expect(source).not.toMatch(/console\.(?:error|warn|log)\s*\(/)
        }
        expect(tools).toContain("enqueueSnackbar('无法导入工具：文件不是有效的 JSON。', { variant: 'error' })")
        expect(credentials).toContain("enqueueSnackbar('加载凭据配置失败，请稍后重试', { variant: 'error' })")
    })

    it('clears every derived marketplace filter after malformed flow data', () => {
        const source = read('../views/marketplaces/index.jsx')

        for (const reset of [
            'setImages({})',
            'setIcons({})',
            'setUsecases([])',
            'setEligibleUsecases([])',
            'setSelectedUsecases([])',
            'setTemplateImages({})',
            'setTemplateIcons({})',
            'setTemplateUsecases([])',
            'setEligibleTemplateUsecases([])',
            'setSelectedTemplateUsecases([])'
        ]) {
            expect(source).toContain(reset)
        }
    })

    it('keeps malformed state metadata editable with an empty option list', () => {
        const source = read('../views/canvas/NodeInputHandler.jsx')
        const helper = read('../views/canvas/stateKeyOptions.js')

        expect(source).toContain("import { getStateKeyOptions } from './stateKeyOptions'")
        expect(source).toContain('let valueOptions = []')
        expect(source).toContain('valueOptions = getStateKeyOptions(datagridValues)')
        expect(source).toContain('editable: true')
        expect(helper).toContain('if (!serializedState) return []')
        expect(helper).toContain('return []')
    })

    it('uses consistent empty history copy and safe HITL failure details', () => {
        const history = read('../views/docstore/UpsertHistorySideDrawer.jsx')
        const execution = read('../views/agentexecutions/NodeExecutionDetails.jsx')

        expect(history).toContain("alt='暂无更新历史'")
        expect(history).not.toContain("alt='暂无更新插入历史'")
        expect(execution).toContain("import { getErrorMessage } from '@/utils/getErrorMessage'")
        expect(execution).toContain("getErrorMessage(error, '提交响应失败，请稍后重试')")
        expect(execution).not.toContain('error.response.data')
    })

    it('renders API key permissions through the shared Chinese mapping', () => {
        const dialog = read('../views/apikey/APIKeyDialog.jsx')
        const list = read('../views/apikey/index.jsx')

        expect(dialog).toContain("import { permissionCategoryLabels, permissionValueLabels } from './permissionLabels'")
        expect(list).toContain("import { getPermissionDisplayLabel } from './permissionLabels'")
        expect(list).toContain("permissions.map(getPermissionDisplayLabel).join('，')")
        expect(list).not.toMatch(/\{d\}\s*\{', '\}/)
    })
})
