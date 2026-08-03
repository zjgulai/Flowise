export const permissionCategoryLabels = {
    chatflows: '聊天流',
    agentflows: '智能体流',
    tools: '工具',
    assistants: '助手',
    credentials: '凭据',
    variables: '变量',
    apikeys: 'API 密钥',
    documentStores: '文档库',
    datasets: '数据集',
    executions: '执行记录',
    evaluators: '评估器',
    evaluations: '评估',
    templates: '模板',
    logs: '日志',
    loginActivity: '登录活动'
}

export const permissionValueLabels = {
    View: '查看',
    Create: '创建',
    Update: '更新',
    Duplicate: '复制',
    Delete: '删除',
    Export: '导出',
    Import: '导入',
    'Edit Configuration': '编辑配置',
    'Allowed Domains': '允许的域名',
    Share: '分享',
    'Delete Document Store': '删除文档库',
    'Add Document Loader': '添加文档加载器',
    'Delete Document Loader': '删除文档加载器',
    'Preview & Process Document Chunks': '预览并处理文档分块',
    'Upsert Config': '更新配置',
    'Run Again': '再次运行',
    'View Marketplace Templates': '查看市场模板',
    'View Custom Templates': '查看自定义模板',
    'Delete Custom Template': '删除自定义模板',
    'Export Tool as Template': '将工具导出为模板',
    'Export Flow as Template': '将流程导出为模板',
    'Share Custom Templates': '分享自定义模板',
    'View Logs': '查看日志',
    'View Login Activity': '查看登录活动'
}

const permissionActionLabels = {
    view: '查看',
    create: '创建',
    update: '更新',
    duplicate: '复制',
    delete: '删除',
    export: '导出',
    import: '导入',
    config: '编辑配置',
    domains: '允许的域名',
    share: '分享',
    'add-loader': '添加文档加载器',
    'delete-loader': '删除文档加载器',
    'preview-process': '预览并处理文档分块',
    'upsert-config': '更新配置',
    run: '再次运行',
    marketplace: '查看市场模板',
    custom: '查看自定义模板',
    'custom-delete': '删除自定义模板',
    toolexport: '将工具导出为模板',
    flowexport: '将流程导出为模板',
    'custom-share': '分享自定义模板'
}

export const getPermissionDisplayLabel = (permissionKey) => {
    if (typeof permissionKey !== 'string') return '未知权限'

    const separatorIndex = permissionKey.indexOf(':')
    if (separatorIndex <= 0 || separatorIndex === permissionKey.length - 1) return '未知权限'

    const category = permissionKey.slice(0, separatorIndex)
    const action = permissionKey.slice(separatorIndex + 1)
    const categoryLabel = permissionCategoryLabels[category]
    const actionLabel = permissionActionLabels[action]

    if (!categoryLabel || !actionLabel) return `未知权限（${permissionKey}）`
    return `${categoryLabel}：${actionLabel}`
}
