# Flowise 管理员专属专业登录页实施方案

日期：2026-07-23
状态：执行中（本地 L2）
目标版本：X0-E7

## 1. 第一性原理与目标

认证入口必须同时回答三个问题：谁能进入、如何安全失败、用户能否清楚理解当前访问边界。视觉升级不能替代服务器授权，隐藏注册链接也不能替代关闭注册 API。

本批目标：

1. 恢复 `/login -> /signin` 的公开密码登录入口。
2. `ADMIN_ONLY_MODE` 默认启用；只允许数据库中既有且状态为 ACTIVE、组织关系为 ACTIVE、工作区关系为 ACTIVE、当前角色为 `owner` 的账号登录。
3. 管理员模式下关闭公开注册、邀请创建、验收码登录和 SSO 入口；不创建默认账号、共享密码或硬编码凭据。
4. 保留忘记密码和重置密码入口，但不触发真实 SMTP 发送。
5. 以 PC 为主重做登录封面；移动端只保证完整可用、无横向溢出。

## 2. 产品与安全合同

### 2.1 模式开关

-   `ADMIN_ONLY_MODE`：未设置或非 `false` 时为 `true`，以 fail-closed 方式保护当前单管理员部署。
-   后端 `/api/v1/settings` 返回 `ADMIN_ONLY_MODE`，供 UI 决定公开入口；该值不包含秘密。
-   `PUBLIC_LOGIN_ENABLED` 继续控制公开登录是否开放；二者不是同一含义。

### 2.2 登录允许条件

管理员模式下，密码正确只是必要条件；签发会话前还必须同时满足：

-   `user.status === active`
-   `workspace_user.status === active`
-   `organization_user.status === active`
-   当前 `workspace_user.roleId` 等于通用 `owner` 角色 ID

任何失败均不修改密码哈希/成员状态、不签发 Cookie、不暴露角色或账号是否存在。显式关闭管理员模式只恢复后端既有多用户能力；公开注册和 SSO 的 UI 仍保持关闭，重新开放必须经过独立产品门禁。

### 2.3 账号创建边界

管理员模式下：

-   `POST /api/v1/account/register` 返回 `403`；不调用注册 service，不写数据库。
-   `POST /api/v1/account/invite` 返回 `403`；不创建邀请或发送邮件。
-   `/register` 不再加载注册表单，统一重定向 `/signin`。
-   登录页不出现注册、邀请码、SSO 或验收码入口。
-   `/api/v1/auth/acceptance-login` 不注册到 Express；`/acceptance-login` 前端路由重定向 `/signin`。

`/organization-setup` 保留以支持空库引导，但管理员模式必须显式关闭后才能创建首个账号；现有生产已初始化，不受影响。

### 2.4 恢复边界

-   忘记密码和重置密码保留。
-   本批只测试未配置 SMTP 的安全反馈与 mock；真实邮件发送另设门禁。
-   错误文案使用统一、克制的中文，不向攻击者区分“账号不存在 / 非管理员 / 已停用”。

## 3. 视觉与交互方案

方向：`可信企业控制台 + 编辑式品牌封面`，避免通用渐变 SaaS 卡片。

-   桌面：左右分栏。左侧深墨蓝品牌封面承载产品价值、运行边界和三条可信承诺；右侧暖白登录区域承载唯一动作。
-   信息层级：品牌标识 → 主张“让每一次智能流转，都有清晰的控制边界” → 三项能力 → 管理员入口状态。
-   登录面板：明确“管理员登录”、账号格式、密码显示切换、忘记密码、加载态、错误态和键盘焦点。
-   颜色：深墨蓝、温暖米白、青绿色状态点和少量琥珀强调；不使用外部字体、插画 CDN 或新增依赖。
-   桌面验收：`1440×900` 与 `1280×800` 首屏完整，无滚动才能提交的关键操作。
-   移动验收：`390×844` 隐藏非必要品牌细节，表单保持完整，无横向溢出。
-   可访问性：语义化 form、可见 label、autocomplete、aria-live 错误区、44px 以上主按钮、可见 focus ring、reduced-motion 安全。

## 4. 实施 TODO

### Gate A — RED 合同

-   [x] 后端 policy 测试：默认管理员模式、显式关闭、注册/邀请拒绝、验收登录不注册。
-   [x] 登录构建测试：ACTIVE owner 通过；member、停用 user/workspace/org 拒绝且零状态写入。
-   [x] Settings 测试：公开 `ADMIN_ONLY_MODE`，默认 true、显式 false。
-   [x] UI route/source 合同：无公开注册/验收表单，管理员文案、无注册 CTA/SSO、桌面布局关键 token。

### Gate B — 最小安全实现

-   [x] 新增纯函数 `adminOnlyPolicy`，集中解析模式与拒绝错误。
-   [x] 在密码登录会话签发前执行 ACTIVE owner 校验，禁止自动激活停用关系。
-   [x] 注册和邀请 controller 在 service 前 fail-closed。
-   [x] 管理员模式下不挂载 acceptance login route。
-   [x] Settings 暴露非秘密模式标记。

### Gate C — UI 实现

-   [x] AuthRoutes 将 `/register`、`/acceptance-login` 重定向到 `/signin`。
-   [x] AuthLayout 仅对 `/signin` 与 `/login` 开启 full-bleed，其它恢复页保持 512px 约束。
-   [x] 重构 SignInPage 为专业封面；删除注册 CTA，管理员模式下不请求/显示 SSO。
-   [x] 加固 API 错误 optional-chain 与统一安全文案。

### Gate D — 本地 L2 闭环

-   [x] focused server/UI tests 转绿：server `16/16`，UI contracts `24/24`。
-   [x] server typecheck、UI full test/build、静态安全、release-source、diff/style 转绿。
-   [x] 本地隔离 build preview + network fixture 启动，不连接生产数据库，不调用 Provider/SMTP。
-   [x] 浏览器验证 `/signin`、`/register`、`/acceptance-login`、错误态及 1440/1280/390 视口；`/login` resolver 合同由 UI tests 覆盖。
-   [x] 记录截图、console、network、横向溢出与残留清理；clean load console=`0 error / 0 warning`，负向 `401` 仅产生浏览器预期网络诊断，UI 显示统一中文恢复文案。

### Gate E — 后续发布（本批不执行）

-   [ ] 原子提交 exact owned paths，构建 clean candidate。
-   [ ] 新授权后设置生产 `PUBLIC_LOGIN_ENABLED=true`、`ADMIN_ONLY_MODE=true`，先备份与 isolated smoke。
-   [ ] 单 Flowise 切换；失败自动回滚。
-   [ ] 使用既有管理员账号完成真实 L4 登录/退出，不读取或输出密码；不创建测试账号。

## 5. 完成定义

本地完成只可表述为 `implementation_complete_local / L2`。只有生产配置、候选切换、管理员真实登录与退出、注册/邀请负向探测、日志和容器不变量全部通过，才可表述为 `deployed_and_authenticated_L4`。
