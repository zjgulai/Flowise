# G1-K 工作区可移植性、MCP Token 与可观测性迁移说明

状态：本地候选，尚未提交、推送、合并或部署
适用基线：Flowise 3.1.3，分支基线 `48573043d5340c61c49553e97deff7141be577d5` 之后的未提交候选

## 工作区导出合同

-   导出文件采用 record-closure：选中记录所需的流程、工具、文档库、消息和执行父记录必须一并包含；缺失时导出固定失败，不生成“部分可恢复”的文件。
-   feedback-only 导出先读取有界反馈，再按 `messageId + chatflowid` 精确读取父消息；不会因工作区存在超过 10,000 条无关消息而拒绝一个很小的反馈导出。
-   消息引用的执行记录按引用 ID、工作区和固定批次精确读取；只有显式选择“执行记录”时才读取该工作区的完整有界执行集合。
-   凭据引用、变量值、MCP 连接、API Key／限流策略及 Provider／HTTP 敏感选项不会作为可恢复绑定进入公开导出。组件 metadata 中标记 `workspaceExportPolicy: rebind` 的本地文件／目录、数据库连接串、TLS 文件、TypeORM `additionalConfig` 和任意 Flow／Tool override 会被移除。为保持结构可移植性，受信组件的端点、主机等目标地址可能保留；绑定新凭据或重新部署前必须逐项核验。自由文本、聊天／文档内容、执行错误和自定义代码仍可能含敏感信息，分享前必须人工审查。
-   默认选择不包含聊天消息、聊天反馈、文档库和执行记录；需要这些用户数据时必须显式勾选。

## 工作区导入合同

-   `ExportManifest` 仅用于提示和版本识别，不能作为安全授权。旧文件、无 manifest 文件和直接 API 请求均执行同一目录驱动清洗。
-   在生成新 ID、打开事务或写数据库前，流程、嵌套 Agent／Tool wrapper、Custom Assistant 和 DocumentStore 配置中的凭据、密码、Header、MCP 连接及 Provider 敏感选项会被移除，所有变量值强制置空；8 个 `loadConfig: true` 动态子配置按实际选择递归清洗，空选择或未知选择 fail closed；受信组件的端点、主机等目标地址可能保留并必须人工复核。
-   导入依赖必须自闭合。导入文件不得引用目标工作区既有的 Flow、Custom Tool、Document Store、Execution 或 Chat Message；这避免仅掌握 UUID 的导入者将新对象绑定到既有资源。
-   所有导入对象使用新 ID、服务端字段 allowlist、insert-only 写入和事务内关系预检。完成后由具备相应权限的管理员重新绑定凭据、变量、MCP 和公开访问策略。
-   `workspace:import` 是可创建流程、模板和 Custom Tool 代码的高信任权限。它不等同于凭据读取权限，但只应授予可以审查并引入可执行内容的管理员或受控维护角色。

上述规则会拒绝依赖目标工作区既有资源的旧版“部分导入”文件。迁移方式是从源工作区重新生成 record-closure 导出，或先将所需依赖加入受控导出；不得通过手工填入目标 UUID 绕过。

## MCP 明文 Token 迁移

-   启动迁移发现旧版 `mcpServerConfig.token` 时，不再把明文转换为继续有效的摘要。配置会被禁用，明文和旧摘要均移除。
-   管理员必须在 UI 中显式重新启用 MCP Server；系统签发全新 Token，且只在该次响应中显示。
-   创建、更新和轮换 Token 的响应设置 `Cache-Control: no-store` 与 `Pragma: no-cache`。
-   公开 MCP endpoint 不接受旧版明文 Token；旧客户端在管理员重新启用并安全分发新 Token 前会中断，这是有意的 fail-closed 行为。
-   描述最大 4,096 字符；迁移会截断更长的旧描述。公开 endpoint 在 bearer 认证和限流后才解析最多 1 MiB 的 JSON。

## MCP 公开请求可观测性

-   早期观察器挂载在整个 `/api/v1/mcp` 命名空间并位于 canonical casing 拒绝之前；因此合法请求、无流程 ID、未授权、混合大小写探测、限流、超限和未知 MCP 路由都能形成同一口径的审计与指标。
-   MCP route 仍在 bearer 鉴权和限流之后才解析最多 1 MiB 的 route-local JSON；未知 method／subpath 在 MCP router 内固定返回 404，不会落入应用级 50 MiB parser。观察器不会读取或缓存请求 body。
-   审计字段严格限定为随机 `requestId`、规范化 `method`、固定 `route`、`statusCode`、数值 `durationMs` 和 `completion`。chatflowId、原始路径、Header、query、body、Token、Cookie、用户输入和错误正文禁止进入日志或指标标签。
-   response `finish` 与 `close` 共用一次性标记；正常响应、客户端中断和异常路径只计一次，避免 Prometheus／OpenTelemetry 重复计数。

## Provider-backed 旧版 Assistant 权限

-   旧版 OpenAI Assistant 已停止新建和破坏性清理，但受迁移兼容约束的 Assistant／Vector Store 读取与非破坏性更新仍可能解密凭据并访问 Provider。
-   这些路径同时要求相应 `assistants:view`／`assistants:update` 业务权限和 `credentials:view`；只拥有 Assistant 权限或只拥有凭据权限都会固定拒绝。
-   Provider 返回的 Assistant、Vector Store 或关联文件分页若缺少数组 `data`、包含重复／无效 ID、缺失翻页函数或超过有界页数／条数，整次读取固定失败；系统不会把畸形页伪装成空列表。
-   公开文件下载路径只读取当前流程已授权的本地存储记录，不使用 Provider credential，因此继续使用其独立的 Flow／API Key 授权合同。

## 发布前操作顺序

1. 在隔离环境备份数据库，并记录不可变候选 SHA、镜像摘要和迁移前后 MCP 配置计数；不得记录 Token 值。
2. 通知 MCP 客户端所有者维护窗口内需要重新领取 Token。
3. 使用与 Web／Worker 一致的强 `TOKEN_HASH_SECRET` 启动候选；任一实例密钥不一致都必须停止晋级。
4. 确认旧明文 MCP 配置全部变为 disabled 且不再包含 `token`／`tokenHash`；只记录聚合数量。
5. 由管理员逐个重新启用需要的 MCP Server，通过受保护渠道分发一次性显示的新 Token。
6. 用合成数据验证工作区 record-closure 导出、全新工作区导入、重新绑定和 MCP 调用；不得在 CI 或公开日志中调用真实 Provider。
7. 抽查 MCP root／尾斜杠、未知 method／subpath、401／404／429／413 和混合大小写请求均有且仅有一条脱敏审计及同口径指标，确认任何日志均无 chatflowId、原始路径、Header、query、body 或 Token。
8. 完成 exact-head CI、不可变镜像、备份恢复演练、双浏览器主链和独立审批后，才能提出生产切换授权。

## 当前不包含的生产闭环

本候选不关闭以下事项：Provider／存储副作用的 durable outbox 与 reconciliation、workspace tombstone、全局 50 MiB parser、公开 multipart 先解析后鉴权、公开 flow/file/feedback/leads BOLA、API Key 明文存储与 URL 验证、Redis／SMTP／用户节点 TLS 校验、历史 Provider 凭据事件、生产密钥连续性、备份恢复和部署后验收。任一项未关闭时，production promotion 保持 NO-GO。
