import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (relativePath) => readFileSync(resolve(__dirname, relativePath), 'utf8')

describe('production UI safety contracts', () => {
    it('gates both public login routes and preserves the access-restricted route', () => {
        const source = read('./AuthRoutes.jsx')
        const loginRoute = source.match(/path: '\/login',[\s\S]*?\n\s*},/)?.[0] ?? ''
        const signInRoute = source.match(/path: '\/signin',[\s\S]*?\n\s*},/)?.[0] ?? ''

        expect(loginRoute).toContain('<PublicLoginRoute>')
        expect(signInRoute).toContain('<PublicLoginRoute>')
        expect(source).toContain("path: '/access-restricted'")
    })

    it('removes public registration and acceptance-login forms from the admin-only route surface', () => {
        const routes = read('./AuthRoutes.jsx')

        expect(routes).toContain("path: '/register'")
        expect(routes).toContain("path: '/acceptance-login'")
        expect(routes.match(/path: '\/register',[\s\S]*?<Navigate to='\/signin' replace \/>/)).toBeTruthy()
        expect(routes.match(/path: '\/acceptance-login',[\s\S]*?<Navigate to='\/signin' replace \/>/)).toBeTruthy()
        expect(routes).not.toContain('AcceptanceLoginPage')
        expect(routes).not.toContain('RegisterPage')
    })

    it('renders a PC-first administrator cover without registration or SSO calls', () => {
        const signIn = read('../views/auth/signIn.jsx')
        const layout = read('../layout/AuthLayout/index.jsx')

        expect(signIn).toContain('管理员登录')
        expect(signIn).toContain('让每一次智能流转')
        expect(signIn).toContain('仅限授权管理员')
        expect(signIn).toContain("gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.08fr) minmax(480px, 0.92fr)' }")
        expect(signIn).toContain("aria-live='polite'")
        expect(signIn).toContain("autoComplete: 'username'")
        expect(signIn).not.toContain("to='/register'")
        expect(signIn).not.toContain('getDefaultProvidersApi.request()')
        expect(signIn).not.toContain('signInWithSSO')
        expect(layout).toContain('isFullBleedAuthPage')
        expect(layout).toContain("pathname === '/signin' || pathname === '/login'")
    })

    it('redirects unauthenticated protected routes to the configured public access boundary', () => {
        const source = read('./RequireAuth.jsx')
        expect(source).toContain("config.PUBLIC_LOGIN_ENABLED === false ? '/access-restricted' : '/login'")
    })

    it('waits for production settings before resolving the unauthenticated root route', () => {
        const source = read('./DefaultRedirect.jsx')
        expect(source).toContain('const { config, isOpenSource, loading } = useConfig()')
        expect(source).toContain('if (loading) return null')
        expect(source).toContain('config.PUBLIC_LOGIN_ENABLED === false')
        expect(source).toContain("<Navigate to='/access-restricted' replace />")
    })

    it('fails closed when platform settings cannot be loaded', () => {
        expect(read('../store/context/ConfigContext.jsx')).toContain('useState({ PUBLIC_LOGIN_ENABLED: false, ADMIN_ONLY_MODE: true })')
    })

    it('protects the account route with RequireAuth', () => {
        const source = read('./MainRoutes.jsx')
        const accountRoute = source.match(/path: '\/account',[\s\S]*?\n\s*},/)?.[0] ?? ''
        expect(accountRoute).toContain('<RequireAuth')
    })

    it('guards both marketplace detail routes before rendering location state', () => {
        const routes = read('./CanvasRoutes.jsx')
        const guard = read('./MarketplaceRouteGuard.jsx')

        expect(routes.match(/<MarketplaceRouteGuard>/g)).toHaveLength(2)
        expect(guard).toContain("<Navigate to='/marketplaces' replace />")
        expect(guard).toContain('JSON.parse(state.flowData)')
    })

    it('uses a bundled fallback when a marketplace node icon cannot load', () => {
        const source = read('../ui-component/cards/ItemCard.jsx')

        expect(source).toContain('flowise_logo.png')
        expect(source).toContain('onError=')
        expect(source).toContain("data.iconSrc.startsWith('/')")
        expect(source).toContain('data.iconSrc || !data.color')
    })

    it('does not fetch the GitHub star count at runtime', () => {
        expect(read('../layout/MainLayout/Header/index.jsx')).not.toContain('api.github.com')
    })

    it('renders the shared error state in Chinese with defensive and responsive recovery controls', () => {
        const source = read('../ErrorBoundary.jsx')

        expect(source).toContain('页面加载失败')
        expect(source).toContain('请稍后重试')
        expect(source).toContain('重新加载')
        expect(source).toContain('复制错误详情')
        expect(source).toContain('error?.response?.status')
        expect(source).toContain('error?.response?.data?.message')
        expect(source).toContain("maxWidth: '100%'")
        expect(source).not.toContain('Oh snap!')
        expect(source).not.toContain('Discord')
        expect(source).not.toContain('Github')
    })

    it('lets the chunks request lifecycle dismiss its loading backdrop after an API error', () => {
        const source = read('../views/docstore/ShowStoredChunks.jsx')

        expect(source).toContain('loading || getChunksApi.loading')
        expect(source).not.toContain('setLoading(true)\n        getChunksApi.request(storeId, fileId, currentPage)')
    })

    it('keeps the audited Account and Chatflows primary copy in Chinese', () => {
        const account = read('../views/account/index.jsx')
        const chatflows = read('../views/chatflows/index.jsx')

        expect(account).not.toContain('\n                                    Save\n')
        expect(chatflows).toContain("description='构建单智能体系统、聊天机器人和基础大模型流程'")
        expect(chatflows).toContain('新增流程')
        expect(chatflows).toContain("gridTemplateColumns={{ xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}")
        expect(chatflows).not.toContain('Add New')
    })

    it('keeps Account save feedback recoverable and Chinese on desktop', () => {
        const account = read('../views/account/index.jsx')

        expect(account).toContain('const getAccountErrorMessage')
        expect(account).toContain('error?.response?.data')
        expect(account).toContain('setIsSavingProfile(true)')
        expect(account).toContain('setIsSavingProfile(false)')
        expect(account).toContain('isSavingProfile ?')
        expect(account).toContain('正在保存…')
        expect(account).toContain('请在当前邮箱')
        expect(account).not.toContain('Failed to update profile:')
        expect(account).not.toContain('Failed to update password:')
    })

    it('lets Agentflow schedule failures leave loading and expose a Chinese state', () => {
        const agentflows = read('../views/agentflows/index.jsx')
        const badge = read('../ui-component/extended/ScheduleStatusBadge.jsx')

        expect(agentflows).toContain('results.forEach(({ id, data, error })')
        expect(agentflows).toContain('error: error === true')
        expect(agentflows).toContain('setCurrentPage(1)')
        expect(agentflows).toContain("aria-label='关闭 V1 弃用提示'")
        expect(agentflows).toContain("gridTemplateColumns={{ xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}")
        expect(badge).toContain('调度状态获取失败')
        expect(badge).toContain('状态获取失败')
        expect(badge).toContain('error: PropTypes.bool')
    })

    it('keeps the Document Store PC list actions Chinese and responsive', () => {
        const documents = read('../views/docstore/index.jsx')
        const table = read('../ui-component/table/DocumentStoreTable.jsx')
        const card = read('../ui-component/cards/DocumentStoreCard.jsx')
        const status = read('../views/docstore/DocumentStoreStatus.jsx')
        const dialog = read('../views/docstore/AddDocStoreDialog.jsx')

        expect(documents).toContain("description='存储并更新用于大模型检索的文档（RAG）'")
        expect(documents).toContain("cancelButtonName: '取消'")
        expect(documents).toContain("confirmButtonName: '添加'")
        expect(documents).toContain("confirmButtonName: '保存'")
        expect(documents).toContain('新增文档库')
        expect(documents).toContain("id='btn_createDocumentStore'")
        expect(documents).toContain("aria-label='文档库操作'")
        expect(documents).toContain("gridTemplateColumns={{ xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}")
        expect(documents).toContain('文档库已删除')
        expect(documents).not.toContain('Add New')
        expect(documents).not.toContain('Document Store deleted.')
        expect(documents).not.toContain('Failed to delete Document Store:')
        expect(table).toContain("aria-label='文档库操作'")
        expect(table).toContain('关联流程')
        expect(table).toContain('字符总数')
        expect(table).toContain('分块总数')
        expect(table).toContain('加载器类型')
        expect(table).not.toContain('Document store options')
        expect(table).not.toContain('Connected flows')
        expect(card).toContain('个流程')
        expect(card).toContain('个字符')
        expect(card).toContain('个分块')
        expect(card).not.toContain(' chars')
        expect(card).not.toContain(' chunks')
        expect(status).toContain("EMPTY: '空库'")
        expect(dialog).toContain('服务请求失败（${status}）')
    })

    it('keeps Document Store create failures editable and offers a list recovery path', () => {
        const dialog = read('../views/docstore/AddDocStoreDialog.jsx')
        const deleteDialog = read('../views/docstore/DeleteDocStoreDialog.jsx')
        const details = read('../views/docstore/DocumentStoreDetail.jsx')
        const chunks = read('../views/docstore/ShowStoredChunks.jsx')
        const boundary = read('../ErrorBoundary.jsx')

        expect(dialog).toContain('const getDocumentStoreErrorMessage')
        expect(dialog).toContain('const [isSubmitting, setIsSubmitting]')
        expect(dialog).toContain('submitErrorSnackbarKey')
        expect(dialog).toContain('dismissSubmitError()')
        expect(dialog).toContain('setIsSubmitting(true)')
        expect(dialog).toContain('setIsSubmitting(false)')
        expect(dialog).toContain('disabled={isSubmitting || !documentStoreName.trim()}')
        expect(dialog).toContain('正在提交…')
        expect(dialog).toContain("id='txtInput_documentStoreName'")
        expect(dialog).toContain("id='txtInput_documentStoreDescription'")
        expect(dialog).toContain("id='btn_submitDocumentStore'")
        expect(dialog).not.toContain('New Document Store created.')
        expect(dialog).not.toContain('Failed to add new Document Store:')
        expect(dialog).not.toContain('Failed to update Document Store:')
        expect(deleteDialog).toContain('取消')
        expect(deleteDialog).toContain('确认删除')
        expect(deleteDialog).not.toMatch(/>\s*Cancel\s*</)
        expect(deleteDialog).not.toMatch(/>\s*Delete\s*</)
        expect(boundary).toContain('onBack')
        expect(boundary).toContain('backLabel')
        expect(details).toContain("backLabel='返回文档库列表'")
        expect(chunks).toContain("backLabel='返回文档库列表'")
    })

    it('keeps ViewHeader actions and search usable on narrow screens', () => {
        const source = read('../layout/MainLayout/ViewHeader.jsx')

        expect(source).toContain("flexDirection: { xs: 'column', sm: 'row' }")
        expect(source).toContain("alignItems: { xs: 'stretch', sm: 'center' }")
        expect(source).toContain("width: { xs: '100%', sm: '260px', xl: '325px' }")
        expect(source).toContain("maxWidth: '100%'")
        expect(source).toContain("flexWrap: 'wrap'")
        expect(source).not.toContain("display: { xs: 'none', sm: 'flex' }")
        expect(source).not.toContain("maxWidth: 'calc(100vh - 100px)'")
    })

    it('searches Chatflows, Agentflows, and Document Stores across server-side pages', () => {
        const chatflows = read('../views/chatflows/index.jsx')
        const agentflows = read('../views/agentflows/index.jsx')
        const documentStores = read('../views/docstore/index.jsx')
        const chatflowController = read('../../../server/src/controllers/chatflows/index.ts')
        const chatflowService = read('../../../server/src/services/chatflows/index.ts')
        const documentStoreController = read('../../../server/src/controllers/documentstore/index.ts')
        const documentStoreService = read('../../../server/src/services/documentstore/index.ts')

        for (const source of [chatflows, agentflows, documentStores]) {
            expect(source).toContain('search: searchTerm.trim()')
            expect(source).toContain('setCurrentPage(1)')
            expect(source).toContain('setTimeout')
        }
        expect(chatflowController).toContain("typeof req.query?.search === 'string'")
        expect(chatflowService).toContain("LOWER(COALESCE(chat_flow.category, '')) LIKE :search")
        expect(documentStoreController).toContain("typeof req.query?.search === 'string'")
        expect(documentStoreService).toContain("LOWER(COALESCE(doc_store.description, '')) LIKE :search")
    })

    it('sorts paginated flow and document lists on the server with allowlisted query fields', () => {
        const chatflows = read('../views/chatflows/index.jsx')
        const agentflows = read('../views/agentflows/index.jsx')
        const documentStores = read('../views/docstore/index.jsx')
        const flowTable = read('../ui-component/table/FlowListTable.jsx')
        const documentStoreTable = read('../ui-component/table/DocumentStoreTable.jsx')
        const chatflowController = read('../../../server/src/controllers/chatflows/index.ts')
        const documentStoreController = read('../../../server/src/controllers/documentstore/index.ts')

        for (const source of [chatflows, agentflows, documentStores]) {
            expect(source).toContain('orderBy:')
            expect(source).toContain('order:')
            expect(source).toContain('setCurrentPage(1)')
        }
        expect(flowTable).toContain('onSortChange?.(property, newOrder)')
        expect(documentStoreTable).toContain('onSortChange?.(property, newOrder)')
        expect(chatflowController).toContain("['name', 'updatedDate'].includes")
        expect(documentStoreController).toContain("['name', 'updatedDate'].includes")
    })

    it('keeps shared PC pagination copy in Chinese', () => {
        const pagination = read('../ui-component/pagination/TablePagination.jsx')
        const flowTable = read('../ui-component/table/FlowListTable.jsx')
        const flowMenu = read('../ui-component/button/FlowListMenu.jsx')

        expect(pagination).toContain('每页数量：')
        expect(pagination).toContain('条，共')
        expect(pagination).not.toContain('Items per page:')
        expect(flowTable).toContain('最近修改时间')
        expect(flowTable).toContain("format('YYYY-MM-DD HH:mm:ss')")
        expect(flowTable).not.toContain('Last Modified Date')
        expect(flowTable).not.toContain("format('MMMM Do, YYYY HH:mm:ss')")
        expect(flowMenu).toContain('操作')
        expect(flowMenu).toContain('另存为模板')
        expect(flowMenu).toContain('getFlowListErrorMessage')
        expect(flowMenu).not.toMatch(/>\s*Options\s*</)
    })

    it('fails closed until organization setup is explicitly allowed by auth resolve', () => {
        const source = read('../views/organization/index.jsx')
        expect(source).toContain('setupAllowed')
        expect(source).toContain('resolveLoginApi')
    })

    it.each([
        ['../views/auth/verify-email.jsx', '验证链接缺少令牌'],
        ['../views/auth/confirm-email-change.jsx', '邮箱变更链接缺少令牌']
    ])('renders a missing-token state in %s', (file, message) => {
        expect(read(file)).toContain(message)
    })
})
