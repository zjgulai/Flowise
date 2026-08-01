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

        expect(source).toContain("import { getErrorMessage } from '@/utils/getErrorMessage'")
        expect(source).toContain("getErrorMessage(error, '页面加载失败，请稍后重试')")
        expect(source).not.toContain('error?.response?.data?.message')
        expect(source).not.toContain('error?.message ??')
        expect(source).toContain('页面加载失败')
        expect(source).toContain('请稍后重试')
        expect(source).toContain('重新加载')
        expect(source).toContain('复制错误详情')
        expect(source).toContain('error?.response?.status')
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
        expect(dialog).toContain("import { getErrorMessage } from '@/utils/getErrorMessage'")
        expect(dialog).toContain("getErrorMessage(error, '未知错误')")
    })

    it('keeps Document Store create failures editable and offers a list recovery path', () => {
        const dialog = read('../views/docstore/AddDocStoreDialog.jsx')
        const deleteDialog = read('../views/docstore/DeleteDocStoreDialog.jsx')
        const details = read('../views/docstore/DocumentStoreDetail.jsx')
        const chunks = read('../views/docstore/ShowStoredChunks.jsx')
        const boundary = read('../ErrorBoundary.jsx')

        expect(dialog).toContain('新增文档库失败：${getErrorMessage')
        expect(dialog).toContain('更新文档库失败：${getErrorMessage')
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

    it('keeps execution dates, shared table copy, and selection names in the Chinese PC contract', () => {
        const executions = read('../views/agentexecutions/index.jsx')
        const details = read('../views/agentexecutions/ExecutionDetails.jsx')
        const table = read('../ui-component/table/ExecutionsListTable.jsx')

        expect(executions).toContain("registerLocale('zh-CN', zhCN)")
        expect(executions.match(/locale='zh-CN'/g)).toHaveLength(2)
        expect(executions.match(/dateFormat='yyyy-MM-dd'/g)).toHaveLength(2)
        expect(executions).toContain("previousMonthAriaLabel='上个月'")
        expect(executions).toContain("nextMonthAriaLabel='下个月'")
        expect(details).toContain("format('YYYY-MM-DD HH:mm:ss')")
        expect(table).toContain("aria-label='执行记录表'")
        expect(table).toContain("'aria-label': `选择执行记录 ${row.agentflow?.name || row.id}`")
        expect(table).toContain('最近更新时间')
        expect(table).toContain('创建时间')
        expect(table.match(/format\('YYYY-MM-DD HH:mm:ss'\)/g)).toHaveLength(2)
        expect(table).not.toContain('Last Updated')
    })

    it('renders the shared file picker placeholder separately from real file data', () => {
        const file = read('../ui-component/file/File.jsx')
        const dataset = read('../views/datasets/AddEditDatasetDialog.jsx')
        const upload = read('../views/datasets/UploadCSVFileDialog.jsx')
        const canvas = read('../views/canvas/NodeInputHandler.jsx')
        const assistant = read('../views/assistants/openai/AssistantDialog.jsx')

        expect(file).toContain("placeholder = '选择要上传的文件'")
        expect(file).toContain("buttonText = '上传文件'")
        expect(file).toContain('(myValue && getFileName(myValue)) || placeholder')
        for (const source of [dataset, upload]) {
            expect(source).toContain("value={selectedFile ?? ''}")
            expect(source).toContain("placeholder='选择要上传的 CSV 文件'")
            expect(source).toContain("buttonText='上传 CSV 文件'")
            expect(source).not.toContain("value={selectedFile ?? '选择要上传的文件'}")
        }
        expect(canvas).toContain("value={data.inputs[inputParam.name] ?? inputParam.default ?? ''}")
        expect(canvas).toContain("placeholder='选择要上传的文件'")
        expect(canvas).toContain("buttonText='上传文件'")
        expect(canvas).not.toContain("'Choose a file to upload'")
        expect(assistant).toContain("value={uploadCodeInterpreterFiles ?? ''}")
        expect(assistant).toContain("value={uploadVectorStoreFiles ?? ''}")
        expect(assistant.match(/placeholder='选择要上传的文件'/g)).toHaveLength(2)
        expect(assistant.match(/buttonText='上传文件'/g)).toHaveLength(2)
    })

    it('labels MCP server annotations as unverified and fails closed when risk hints are incomplete', () => {
        const source = read('../views/tools/CustomMcpServerDialog.jsx')
        const riskClassifier = read('../utils/getMcpToolRiskHints.js')

        expect(source).toContain("label='声明只读'")
        expect(source).toContain("label={additiveWrite ? '声明可追加写入' : '声明可写入'}")
        expect(source).toContain("label='声明非幂等'")
        expect(source).toContain('服务器声明此工具为只读；该注解未经验证')
        expect(source).toContain("label='风险未知'")
        expect(source).toContain('服务器未完整声明工具风险')
        expect(source).toContain("role='button'")
        expect(source).toContain('aria-expanded={expanded}')
        expect(source).toContain('aria-controls={detailsId}')
        expect(source).toContain('if (event.target !== event.currentTarget) return')
        expect(source).not.toMatch(/const HintChip[\s\S]*?tabIndex=\{0\}[\s\S]*?HintChip\.propTypes/)
        expect(riskClassifier).toContain('destructive: writable && annotations.destructiveHint !== false')
        expect(riskClassifier).toContain('nonIdempotent: writable && annotations.idempotentHint !== true')
        expect(riskClassifier).toContain('openWorld: annotations.openWorldHint !== false')
        expect(source).not.toContain('此工具不会修改任何数据')
    })

    it('keeps text-to-speech tests Chinese and preserves safe controlled failure details', () => {
        const source = read('../ui-component/extended/TextToSpeech.jsx')

        expect(source).toContain("text: '今天是使用 Flowise 构建智能应用的美好一天！'")
        expect(source).toContain('语音测试失败：HTTP 请求状态码 ${response.status}')
        expect(source).toContain("message: '语音测试失败：未收到音频数据'")
        expect(source).toContain("getErrorMessage(error, '网络或浏览器错误')")
        expect(source).not.toMatch(/console\.error\s*\(/)
        expect(source).not.toContain("throw new Error('未收到音频数据')")
    })

    it('keeps API key, Chatbot, and Marketplace network failures on the safe error path', () => {
        for (const file of [
            '../views/apikey/APIKeyDialog.jsx',
            '../views/apikey/index.jsx',
            '../views/chatflows/ShareChatbot.jsx',
            '../views/marketplaces/index.jsx'
        ]) {
            const source = read(file)
            expect(source).toContain("getErrorMessage(error, '未知错误')")
            expect(source).not.toContain('error.response.data')
        }
    })

    it('keeps canvas and generated-flow failures on the safe error path', () => {
        const canvas = read('../views/canvas/index.jsx')
        const agentflowCanvas = read('../views/agentflowsv2/Canvas.jsx')
        const nodeInput = read('../views/canvas/NodeInputHandler.jsx')
        const generator = read('../ui-component/dialog/AgentflowGeneratorDialog.jsx')

        for (const source of [canvas, agentflowCanvas, nodeInput, generator]) {
            expect(source).toContain("import { getErrorMessage } from '@/utils/getErrorMessage'")
            expect(source).not.toContain('error.response.data')
            expect(source).not.toContain('error.response?.data?.message')
        }
        expect(canvas).toContain('getErrorMessage(error, `删除${canvasTitle}失败，请稍后重试`)')
        expect(agentflowCanvas).toContain("getErrorMessage(error, '删除流程失败，请稍后重试')")
        expect(nodeInput.match(/getErrorMessage\(error, '生成文档库工具描述失败，请稍后重试'\)/g)).toHaveLength(2)
        expect(generator).toContain("getErrorMessage(error, '生成智能体流程失败，请重试')")
        expect(generator).not.toContain('message: response.error')
    })

    it('keeps chat and text-to-speech failures localized without exposing raw errors', () => {
        const chat = read('../views/chatmessage/ChatMessage.jsx')
        const popup = read('../views/chatmessage/ChatPopUp.jsx')
        const validation = read('../views/chatmessage/ValidationPopUp.jsx')
        const streamGuard = read('../utils/createChatStreamGuard.js')
        const ttsLifecycle = read('../utils/ttsStreamingLifecycle.js')

        for (const source of [chat, popup, validation]) {
            expect(source).toContain("import { getErrorMessage } from '@/utils/getErrorMessage'")
            expect(source).not.toMatch(/console\.(?:error|warn|log)\s*\(/)
            expect(source).not.toContain('error.response.data')
            expect(source).not.toContain('error.response?.data?.message')
        }
        expect(chat).toContain('语音播放失败：HTTP 请求状态码 ${response.status}')
        expect(chat).toContain("getErrorMessage(error, '网络或浏览器错误')")
        expect(chat).toContain('await fetchResponseFromEventStream(chatflowid, params)')
        expect(chat).toContain('signal: abortController.signal')
        expect(chat).toContain('streamGuard.assertTerminalClose()')
        expect(chat).not.toContain('async onmessage')
        expect(chat).not.toContain('async onerror')
        expect(chat).toContain('ttsStreamingResourcesRef')
        expect(chat).toContain('expectedSessionId')
        expect(chat).toContain('initializationWatchdog')
        expect(streamGuard).toContain("throw new Error('stream_closed')")
        expect(streamGuard).toContain("throw new Error('stream_failed')")
        expect(ttsLifecycle).toContain('resources.sourceBuffer.abort()')
        expect(ttsLifecycle).toContain('resources.reader.cancel()')
        expect(ttsLifecycle).toContain('revokeObjectURL(resources.objectUrl)')
        expect(chat).toContain("case 'tts_error':")
        expect(chat).not.toContain('Raw data:')
        expect(chat).not.toContain('error.message')
        expect(popup).toContain("getErrorMessage(error, '清空对话记录失败，请稍后重试')")
        expect(validation).toContain("getErrorMessage(error, '流程验证失败，请稍后重试')")
    })

    it('keeps reviewed G1 error sinks fail-closed and out of the browser console', () => {
        const promptGenerator = read('../ui-component/dialog/PromptGeneratorDialog.jsx')
        const codeDialog = read('../ui-component/dialog/ExpandTextDialog.jsx')
        const canvasHeader = read('../views/canvas/CanvasHeader.jsx')
        const sourceDocument = read('../ui-component/dialog/SourceDocDialog.jsx')
        const publicExecutionRoute = read('../../../server/src/routes/public-executions/index.ts')
        const publicExecutionService = read('../../../server/src/services/executions/index.ts')

        expect(promptGenerator).toContain("getErrorMessage(error, '生成指令失败，请稍后重试')")
        expect(promptGenerator).not.toContain('error.response.data')
        expect(codeDialog).toContain("getErrorMessage(executeCustomFunctionNodeApi.error, '代码执行失败，请检查输入和运行环境')")
        expect(codeDialog).not.toContain('executeCustomFunctionNodeApi.error?.response?.data')
        expect(canvasHeader).toContain("getErrorMessage(toggleScheduleEnabledApi.error, '切换调度失败，请稍后重试')")
        expect(canvasHeader).not.toContain('toggleScheduleEnabledApi.error?.message')
        expect(sourceDocument).toContain("import { redactErrorDetails } from '@/utils/redactErrorDetails'")
        expect(sourceDocument).toContain('src={redactedData}')
        expect(sourceDocument).not.toContain('src={data}')
        expect(publicExecutionRoute).toContain("router.get('/:id', executionController.getPublicExecutionById)")
        expect(publicExecutionRoute).not.toContain("['/', '/:id']")
        expect(publicExecutionService).toContain('!executionId || !isValidUUID(executionId)')
        expect(publicExecutionService).toContain('公开执行记录不存在')
        expect(publicExecutionService).toContain('读取公开执行记录失败')

        for (const file of [
            '../layout/MainLayout/Header/index.jsx',
            '../layout/MainLayout/Header/OrgWorkspaceBreadcrumbs/index.jsx',
            '../layout/MainLayout/Header/WorkspaceSwitcher/index.jsx',
            '../layout/MainLayout/Sidebar/CloudMenuList.jsx',
            '../store/context/ErrorContext.jsx',
            '../ui-component/dialog/AboutDialog.jsx',
            '../ui-component/dialog/ViewMessagesDialog.jsx',
            '../ui-component/dropdown/AsyncDropdown.jsx',
            '../ui-component/extended/AnalyseFlow.jsx',
            '../ui-component/extended/SpeechToText.jsx',
            '../ui-component/grid/DataGrid.jsx',
            '../ui-component/subscription/PricingDialog.jsx',
            '../views/agentexecutions/NodeExecutionDetails.jsx',
            '../views/agentexecutions/index.jsx',
            '../views/agentflows/index.jsx',
            '../views/assistants/custom/CustomAssistantConfigurePreview.jsx',
            '../views/assistants/openai/AssistantDialog.jsx',
            '../views/canvas/CanvasHeader.jsx',
            '../views/canvas/CredentialInputHandler.jsx',
            '../views/canvas/NodeInputHandler.jsx',
            '../views/docstore/DocumentStoreDetail.jsx',
            '../views/docstore/index.jsx',
            '../views/marketplaces/index.jsx',
            '../views/tools/index.jsx'
        ]) {
            expect(read(file)).not.toMatch(/console\.(?:error|warn)\s*\(/)
        }
    })

    it('keeps NVIDIA NIM installer and container errors on the safe display path', () => {
        const source = read('../ui-component/dialog/NvidiaNIMDialog.jsx')

        expect(source).toContain("import { getErrorMessage } from '@/utils/getErrorMessage'")
        expect(source).toContain("getErrorMessage(err, '下载安装程序失败，请稍后重试')")
        expect(source).toContain("getErrorMessage(err, '拉取镜像失败，请稍后重试')")
        expect(source).toContain("getErrorMessage(err, '启动容器失败，请稍后重试')")
        expect(source.match(/getErrorMessage\(err, '检查容器状态失败，请稍后重试'\)/g)).toHaveLength(4)
        expect(source).not.toContain('err.response.data.message')
        expect(source).not.toContain('err.response?.data?.message')
        expect(source).not.toContain('err.message')
    })

    it('accepts OAuth2 popup messages only from the same-origin authorization window', () => {
        const source = read('../views/credentials/AddEditCredentialDialog.jsx')

        expect(source).toContain("import { getTrustedOAuth2MessageType } from '@/utils/getTrustedOAuth2MessageType'")
        expect(source).toContain('expectedOrigin: window.location.origin')
        expect(source).toContain('expectedSource: authWindow')
        expect(source).toContain("message: 'OAuth2 授权失败，请重试'")
        expect(source).not.toContain('message: event.data.message')
        expect(source).not.toContain("console.error('OAuth2 授权错误：', error)")
        expect(source).not.toContain('error.response?.data?.message || error.message')
        expect(source).not.toContain('setError(error)')
        expect(source).not.toContain('setError(getSpecificCredentialApi.error)')
        expect(source).not.toContain('setError(getSpecificComponentCredentialApi.error)')
    })

    it('keeps the shared pricing dialog Chinese and its subscription failure path defined', () => {
        const source = read('../ui-component/subscription/PricingDialog.jsx')

        expect(source).toContain("import { getErrorMessage } from '@/utils/getErrorMessage'")
        expect(source).toContain("getErrorMessage(error, '无法验证订阅状态，请稍后重试')")
        expect(source).not.toContain('err.response')
        expect(source).toContain('订阅方案')
        expect(source).toContain('当前方案')
        expect(source).toContain('确认更改订阅方案')
        expect(source).toContain('在账单门户中添加付款方式')
        expect(source).toContain("localizePricingCopy(plan.price, '请咨询客服')")
        expect(source).toContain("enqueueSnackbar('账单门户暂不可用，请稍后重试'")
        expect(source).toContain("getErrorMessage(error, '无法打开账单门户，请稍后重试')")
        expect(source).toContain("toLocaleDateString('zh-CN'")
        expect(source).not.toContain('Subscription updated successfully!')
        expect(source).not.toContain('Opening Billing Portal...')
    })

    it('keeps shared header controls keyboard-operable and import/export errors defined', () => {
        const header = read('../layout/MainLayout/Header/index.jsx')
        const profile = read('../layout/MainLayout/Header/ProfileSection/index.jsx')
        const cloudMenu = read('../layout/MainLayout/Sidebar/CloudMenuList.jsx')
        const trial = read('../layout/MainLayout/Sidebar/TrialInfo.jsx')

        expect(header).toMatch(/<ButtonBase[\s\S]*?onClick=\{handleLeftDrawerToggle\}[\s\S]*?<Avatar/)
        expect(profile).toMatch(/<ButtonBase[\s\S]*?onClick=\{handleToggle\}[\s\S]*?aria-label='打开账户菜单'/)
        expect(profile).toContain("import { getErrorMessage } from '@/utils/getErrorMessage'")
        expect(profile).toContain("getErrorMessage(importAllApi.error, '导入文件无效')")
        expect(profile).toContain("getErrorMessage(exportAllApi.error, '服务器内部错误')")
        expect(profile).not.toContain("from '@/utils/errorHandler'")
        expect(cloudMenu).toContain("<ListItemButton\n                            component='a'")
        expect(cloudMenu).not.toContain("<a href='https://docs.flowiseai.com'")
        expect(trial).toContain("component='a'")
        expect(trial).not.toContain('<a href={billingPortalUrl}')
    })

    it('keeps the assistant tool-delete icon accessible in Chinese', () => {
        expect(read('../views/assistants/custom/CustomAssistantConfigurePreview.jsx')).toContain("aria-label='删除工具'")
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
