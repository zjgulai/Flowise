import { getErrorMessage } from './errorHandler'

export const stringify = (object) => {
    try {
        return JSON.stringify(object, null, 2)
    } catch (error) {
        throw new Error(`exportImport.stringify ${getErrorMessage(error)}`)
    }
}

/**
 * The server returns the canonical, sanitized and fresh-target validated
 * artifact. The browser may remove only its download filename envelope; it
 * must not rewrite or re-sanitize the object that passed server validation.
 */
export const exportData = (serverResponse) => {
    try {
        if (!serverResponse || typeof serverResponse !== 'object' || Array.isArray(serverResponse)) {
            throw new Error('Invalid workspace export response')
        }
        const { FileDefaultName: _fileDefaultName, ...artifact } = serverResponse
        return artifact
    } catch (error) {
        throw new Error(`exportImport.exportData ${getErrorMessage(error)}`)
    }
}

const REQUIRED_REBIND_ITEMS = [
    'credentials',
    'variable-values',
    'mcp-connections',
    'api-key-and-rate-limit-policy',
    'provider-and-http-options',
    'local-file-and-directory-paths'
]
const REQUIRED_REVIEW_ITEMS = ['preserved-provider-and-http-targets']
const REBIND_LABELS = {
    credentials: '凭据',
    'variable-values': '变量值',
    'mcp-connections': 'MCP 连接',
    'api-key-and-rate-limit-policy': 'API 密钥与限流策略',
    'provider-and-http-options': '模型服务商／HTTP 敏感选项（包括基础选项与请求头）',
    'local-file-and-directory-paths': '本机文件、目录、数据库与证书路径'
}
const REVIEW_LABELS = {
    'preserved-provider-and-http-targets': '保留的模型服务商／HTTP 端点与主机地址'
}

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

export const getWorkspaceImportConfirmation = (artifact) => {
    if (!isPlainObject(artifact)) throw new Error('导入文件必须是 JSON 对象')
    const manifest = artifact.ExportManifest
    if (manifest === undefined) {
        return {
            title: '确认导入旧版工作区文件',
            description:
                '该文件没有可验证的导出清单，无法确认其净化范围或依赖完整性。仅在信任来源时继续；导入后必须重新检查并绑定凭据、变量值、MCP 连接、API 密钥、限流策略、模型服务商／HTTP 敏感选项及环境依赖，并逐项核验可能保留的端点与主机地址。'
        }
    }
    if (!isPlainObject(manifest) || manifest.formatVersion !== 1 || manifest.dependencyMode !== 'record-closure') {
        throw new Error('不支持的工作区导出格式或版本')
    }
    if (manifest.contentWarning !== 'contains-user-data-and-custom-code-review-before-sharing') {
        throw new Error('工作区导出清单缺少有效的内容安全警告')
    }
    if (!Array.isArray(manifest.rebindRequired) || manifest.rebindRequired.some((item) => typeof item !== 'string' || !item)) {
        throw new Error('工作区导出清单的重新绑定项无效')
    }
    const rebindItems = [...new Set(manifest.rebindRequired)]
    if (REQUIRED_REBIND_ITEMS.some((item) => !rebindItems.includes(item))) {
        throw new Error('工作区导出清单缺少必要的重新绑定项')
    }
    if (!Array.isArray(manifest.reviewRequired) || manifest.reviewRequired.some((item) => typeof item !== 'string' || !item)) {
        throw new Error('工作区导出清单的安全复核项无效')
    }
    const reviewItems = [...new Set(manifest.reviewRequired)]
    if (REQUIRED_REVIEW_ITEMS.some((item) => !reviewItems.includes(item))) {
        throw new Error('工作区导出清单缺少必要的安全复核项')
    }
    return {
        title: '确认导入工作区数据',
        description: `文件可能包含聊天与文档内容、执行历史和错误文本、提示词、自定义代码及其他自由文本，请先确认来源并完成安全审查。导入只恢复结构及所选用户内容；完成后仍需重新绑定：${rebindItems
            .map((item) => REBIND_LABELS[item] ?? item)
            .join('、')}。为保持结构可移植性，以下目标地址可能保留，绑定新凭据或重新部署前必须逐项核验：${reviewItems
            .map((item) => REVIEW_LABELS[item] ?? item)
            .join('、')}。`
    }
}
