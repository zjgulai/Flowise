---
title: Flowise controlled-browser acceptance login design
date: 2026-07-22
status: written_spec_approved_for_implementation_planning
source_baseline: 61fffda7b8736e4560f9ecf4992c3c1d225b9ed4
production_baseline: d7bfcd615dfd969e3c05ef502f809f57e737a96a
authorization: owner_approved_written_spec_and_single_file_commit
evidence_grade: L1_source_and_design_review
production_write: false
database_write: false
provider_call: false
live_send: false
deployment: false
merge: false
---

# Flowise Controlled-Browser Acceptance Login

## 目标

为 `PUBLIC_LOGIN_ENABLED=false` 的生产实例增加一条默认不可用、短时、单次、仅限 run-scoped synthetic identity 的同源认证通道，使受控浏览器可以通过正常页面导航、表单输入和 Cookie 响应完成认证，而不注入浏览器状态、不使用 raw CDP，也不切换到替代浏览器。

本设计只解决生产候选版本的 authenticated browser acceptance 入口。它不开放普通登录，不新增真实用户认证能力，也不扩大 Flowise 产品功能或生产验收范围。

## 当前事实与证据边界

-   `PUBLIC_LOGIN_ENABLED=false` 只让前端 `PublicLoginRoute` 显示 `AccessRestricted`；`POST /api/v1/auth/login` 仍在 server whitelist 中。临时恢复普通登录页不能形成 synthetic-only 安全边界。
-   当前标准登录成功路径已经执行 session regeneration、`req.login`、JWT/refresh token Cookie 签发，可以复用成功后的 session/cookie 语义。
-   `User` 已有唯一、可空的 `tempToken` 与 `tokenExpiry` 字段；本设计复用这两个字段，不新增 migration。
-   当前 request logger 在 debug 模式会记录未被 `LOG_SANITIZE_BODY_FIELDS` 命中的 request body。Acceptance endpoint 必须由代码硬排除，不能依赖部署配置脱敏。
-   July 22 candidate `61fffda7...` 已通过 candidate runtime、cutover/postcheck/edge，但 authenticated L4 在 UI interaction 前因受控浏览器拒绝 session injection 而停止。Synthetic 数据已双清理并回滚，生产恢复 `d7bfcd...`。该历史 run 不能作为新候选的 browser acceptance。
-   本 spec 最高证据为 L1 source/design review；尚未运行 RED、实现、build、浏览器、生产连接或部署。

## 范围

### 本批包含

1. 新增同源页面 `/acceptance-login`，只接收一次性认证码。
2. 新增 `POST /api/v1/auth/acceptance-login`。
3. 复用 `User.tempToken/tokenExpiry` 保存 namespaced hash 和过期时间。
4. 用条件更新 compare-and-set（CAS）原子消费 token。
5. 把密码校验后的 `LoggedInUser` 构建逻辑提取为可复用的 server-side 单元。
6. 复用现有 session regeneration、Passport login、session save 和 HttpOnly/Secure Cookie 语义。
7. 增加同源、CORS、request header、rate limit、日志排除和通用错误合同。
8. 增加 focused/full tests、本地受控浏览器 L2、clean candidate 和另行授权后的生产 L3/L4 合同。

### 本批不包含

-   开放 `/signin` 或改变 `PUBLIC_LOGIN_ENABLED=false`。
-   真实用户、邀请用户、SSO、OAuth、password reset 或 email verification 登录。
-   新数据表、migration、新 dependency、Redis 或外部认证服务。
-   flow execution、文件上传/vector、Provider、SMTP、member/RBAC。
-   Nginx、PostgreSQL、firewall、CSP、restore、registry push、merge/push/PR。
-   绕过受控浏览器策略的 session injection、raw CDP、standalone Playwright/Cypress 或替代浏览器。

## 方案比较

### A. 现有字段 + CAS 原子消费（采用）

一次性码使用 32 字节加密随机数。Owner-side controller 在内存中生成明文，只把 namespaced SHA-256 和 expiry 交给生产 provision helper。Server 用带 user/token/expiry/status/namespace 条件的单条 UPDATE 清空 token；只有 `affected=1` 的请求进入 session 创建。

优点：无 migration、无锁等待、并发最多一个成功，且可覆盖项目支持的数据库。代价：`tempToken` 同时服务既有账号 token 流程，必须通过 namespace、synthetic email、`credential IS NULL` 和 dedicated user 将语义隔离。

### B. 事务 + pessimistic row lock（拒绝）

先锁定 token row，再校验和清空。原子性明确，但不同数据库的锁支持和等待行为不同，也扩大了事务失败面；对单行一次性消费没有必要。

### C. 专用 acceptance-token 表（拒绝）

语义和审计最清楚，但需要 migration、rollback/restore 合同与生产 schema 变更，超出最小范围。

### D. 临时恢复普通登录页（拒绝）

标准登录 API 本来就是 public whitelist；恢复页面既不能限制 synthetic identity，也不提供一次性、短时和原子消费语义。

## 安全不变量

### Synthetic identity

-   Email 必须匹配 `flowise-acceptance+<run-id>@acceptance.invalid`；`run-id` 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`。
-   `credential` 必须为 `NULL`，因此标准 `/auth/login` 无法认证该身份。
-   User、organization、workspace、organization membership 和 workspace membership 必须是本 run 创建的 ACTIVE synthetic 对象；验收不得复用真实或历史对象。
-   所需 owner 权限只存在于该 synthetic workspace；不修改现有 organization/workspace/role。

### 一次性码

-   明文是 `randomBytes(32).toString('base64url')` 生成的 43 字符高熵值，并必须匹配 `^[A-Za-z0-9_-]{43}$`。
-   Hash 输入固定为 UTF-8 `flowise-acceptance:v1\0<raw-code>`，数据库只保存 `acceptance:v1:<sha256-hex>`；TTL 固定为 5 分钟，不提供 grace period。
-   明文不得进入 URL、query、fragment、server/Nginx 日志、Web Storage、Redux、screenshot、evidence、plan/progress 或 shell history。
-   Owner-side controller 必须在同一受控内存边界内完成生成、remote hash provision 与敏感 form fill。若浏览器 connector 不能在不回显明文的情况下接收敏感字段，停止并请求 Owner 手工输入；不得回退到文件、URL、session injection 或 raw CDP。

### Request boundary

-   Endpoint 只接受 `POST` 和 JSON。
-   `Origin` 必须存在并与 `APP_URL` origin 精确相等；不接受 `null` 或无 Origin 的 server-to-server 请求。
-   必须带 UI 已有的 `x-request-from: internal` header，并把 endpoint 加入 session-endpoint CORS 合同。
-   使用现有 `express-rate-limit` dependency 设置独立的每 IP 固定窗口限制。建议合同为 60 秒最多 5 次；rate limit 只减小 DB/log DoS，不作为认证安全基础。
-   Unsupported method、Origin、header、content type、合法 JSON 的错误 body、invalid、expired、consumed、namespace mismatch、identity mismatch 和 membership mismatch 全部返回相同的 `404` status/body；rate limit 单独返回 `429`。
-   畸形 JSON 和超过全局 body limit 的请求会在 endpoint 前由既有 parser 分别拒绝为 `400/413`；响应不得回显 body 或认证码，也不得据此推断 token 状态。
-   Acceptance endpoint 必须加入 request logger 的硬排除列表；实现和测试不得依赖 `LOG_SANITIZE_BODY_FIELDS`。

### Session boundary

-   Token 必须在 session 创建前完成 CAS 消费。
-   CAS 成功后依次执行 session regeneration、`req.login`、显式 session save、既有 JWT/refresh Cookie 签发。
-   Session 或 Cookie 阶段失败时不恢复 token；清理可能产生的不完整 session，并要求生成新 token。
-   成功响应继续使用既有 HttpOnly、Secure、SameSite=Lax Cookie 属性，不新增 JavaScript 可读认证状态。

## 组件设计

### 1. Acceptance token policy

新增无状态 policy helper，职责仅限：

-   校验 raw code 类型、固定长度和 base64url 字符集；
-   计算 `acceptance:v1` namespaced SHA-256；
-   校验 synthetic email/run-id namespace；
-   判断 server time 是否早于 `tokenExpiry`；
-   生成固定内部事件码，不生成包含输入值的错误。

Policy 不访问数据库、不创建 session，也不记录输入。

### 2. Token provision 与 CAS consume

Production provision helper 继续拥有 synthetic identity 的创建和 reaper 责任，但调整为：

1. 创建 `credential=NULL` 的 run-scoped ACTIVE user/memberships。
2. 通过 stdin 接收 owner-side controller 计算出的 namespaced hash 和 absolute UTC expiry；不通过 argv、shell history 或 stdout 传递，也不接收明文。
3. 写入该 synthetic user 的 `tempToken/tokenExpiry`。
4. 只返回非敏感 run/status/count，不返回 user email、hash 或 token。

Server consume 流程：

```text
validate origin/header/content-type/body shape
  -> hash raw code
  -> find user by exact namespaced tempToken
  -> validate synthetic namespace, credential NULL, ACTIVE identity/memberships
  -> conditional UPDATE user
       SET tempToken = NULL, tokenExpiry = NULL
       WHERE id = expected
         AND tempToken = expected hash
         AND tokenExpiry > server now
         AND status = active
         AND credential IS NULL
         AND email matches the exact expected synthetic identity
  -> require affected = 1
  -> build LoggedInUser
  -> establish session and cookies
```

SELECT 与 UPDATE 之间出现并发时，第二个请求得到 `affected=0`。更新后任何失败都保持 token consumed，避免 ambiguous replay。

### 3. Shared LoggedInUser builder

从 Passport local strategy 中提取“credential 已验证之后”的 identity/membership/workspace/role/features 组装逻辑。Public interface 接收已经验证的 user 和 query runner，返回 `LoggedInUser`；它不接受 raw password/token，也不自行放宽 status、workspace 或 permission 校验。

标准 password login 先完成现有 credential validation，再调用 builder；acceptance login 只有 CAS 成功后调用同一 builder。这样两条路径共享 session 用户结构，而认证因子保持隔离。

### 4. HTTP controller

Controller 只编排 policy、consume、builder 和 session establishment。`app.all` 先为 unsupported method 固定同一 `404` 合同，再由 `POST` handler 处理认证：

-   所有 pre-consume 拒绝固定返回 `404` 与 `{ "message": "认证不可用或已失效，请重新生成一次性认证码。" }`。
-   成功返回现有 safe user shape，不返回 token metadata。
-   Internal log 只允许固定 event code、request ID 和非敏感 run ID；禁止 raw code、hash、email、cookie 和 user ID。
-   Response 添加 `Cache-Control: no-store`、`Pragma: no-cache` 和 `Referrer-Policy: no-referrer`。

### 5. UI route

`/acceptance-login` 位于 `AuthLayout` 下，但不使用 `PublicLoginRoute`。页面固定包含：

-   中文标题与边界说明；
-   单个 `type=password`、`autocomplete=one-time-code` 输入；
-   提交按钮和统一错误 feedback；
-   submitting guard。

页面不请求“当前是否启用”，不接收 email/password，不读取 URL token，不写 Redux/Web Storage。成功后先清空组件 state，再把 safe user 交给既有 auth store 并导航 `/account`；失败也清空输入。普通 `/signin`、`/login` 与 default redirect 行为保持不变。

## 数据与秘密流

```text
Owner-side controller memory
  ├─ raw code -> controlled browser sensitive form fill -> HTTPS POST body
  └─ namespaced SHA-256 -> protected remote provision helper -> synthetic user tempToken

Flowise server
  HTTPS body -> validate/hash -> CAS clear tempToken -> session regeneration
     -> server-side session store + HttpOnly cookies -> authenticated browser

Evidence
  revision/image/config/run/status/count/hash-of-artifact only
  raw code/token hash/cookie/synthetic email excluded
```

明文生命周期在 form submit 后立即结束。Controller、browser、remote helper 和 reaper 的 finally 路径必须清空持有的敏感变量；任何 connector 自动记录敏感 input 的行为都是停止条件。

## 失败状态矩阵

| 阶段                                                  | 对外行为       | Token 状态            | Session 状态            | 后续动作                                |
| ----------------------------------------------------- | -------------- | --------------------- | ----------------------- | --------------------------------------- |
| Method/Origin/header/content type/合法 JSON body 拒绝 | 通用 404       | 不变                  | 不创建                  | 可在 rate limit 内重试                  |
| 畸形 JSON / body 超限                                 | parser 400/413 | 不变                  | 不创建                  | 不回显请求内容                          |
| 无效、过期、已消费或 identity mismatch                | 同一通用 404   | 不变或已消费          | 不创建                  | 生成新 token；不泄漏原因                |
| Rate limit                                            | 429            | 不变                  | 不创建                  | 等待窗口或停止异常流量                  |
| CAS 并发第二名                                        | 通用 404       | 已由胜者消费          | 不创建                  | 不重试旧 token                          |
| CAS 成功、builder 失败                                | 通用 500       | 已消费                | 不创建                  | 修复 synthetic provision 后生成新 token |
| CAS 成功、session/login/save 在响应提交前失败         | 通用 500       | 已消费                | 销毁不完整 session      | 生成新 token；不得恢复旧 token          |
| Session save 后客户端/传输中断                        | 响应结果不确定 | 已消费                | 可能存在 scoped session | 停止验收；由 double reaper 收敛         |
| Browser policy block                                  | 停止 L4        | 依实际阶段清理        | 清理                    | 双 reaper、postcheck、回滚 candidate    |
| Reaper/residue/baseline drift                         | 停止发布       | 清理失败视为 incident | 清理失败视为 incident   | 不晋级，按 journal 执行 rollback/rescue |

## TDD 测试设计

### RED 1：Policy 与 namespace

-   非 string、空、过短/过长、非法 base64url 失败。
-   同一 raw code 产生稳定 `acceptance:v1` hash；不同 code 不相等。
-   真实 email、近似前缀、非法 run-id、超长 run-id 失败。
-   过期边界严格使用 server time，不接受等于 expiry。
-   Error/message/snapshot 不包含 raw code 或 hash。

### RED 2：CAS 与 identity

-   合法 ACTIVE synthetic user、`credential=NULL`、有效 membership 得到 `affected=1` 并清空 token/expiry。
-   expired、consumed、non-synthetic、real user、credential present、inactive user、missing/inactive membership 均不能建立 session。
-   两个并发 consume 恰好一个成功；第二个必须是通用失败。
-   SELECT 后 token 被另一个请求消费时，本请求因 `affected=0` 失败。
-   Builder 或 session failure 后 token 不恢复。

### RED 3：HTTP/session/security

-   GET/PUT、无 Origin、`Origin:null`、cross-origin、非 JSON、缺内部 header 返回统一 404；畸形 JSON/超限 body 保持既有 parser 400/413 且不回显输入。
-   同源 JSON 请求进入 consume；rate limit 在阈值后返回 429，窗口前的失败不泄漏 token 状态。
-   Session operation order 固定为 `regenerate -> login -> save -> cookies/response`。
-   regenerate/login/save 在响应提交前任一步失败都不返回 cookies，并销毁不完整 session；save 后传输中断进入 scoped reaper 合同。
-   Request logger 对 acceptance endpoint 完全跳过，即使 `DEBUG=true` 且没有 sanitize env。
-   Acceptance endpoint 被 session CORS contract 识别；wildcard origin 不得放行。
-   Standard `/auth/login` 无法登录 `credential=NULL` synthetic identity。

### RED 4：UI

-   `PUBLIC_LOGIN_ENABLED=false` 时 `/signin` 仍 restricted，`/acceptance-login` 显示单字段表单。
-   Source contract 不存在 query/hash token、email/password input、localStorage/sessionStorage 写入。
-   提交只发送 `{ code }`，按钮在 pending 时不可重复提交。
-   成功和失败均清空 code；成功导航 `/account`，失败保留页面并显示统一中文反馈。
-   PC 1440/1280 和 mobile 390 的主控件在 viewport 内，无横向溢出。

### GREEN 与回归

严格按上述 RED 顺序写最小实现；每个 RED 必须先以预期原因失败。完成后运行：

-   focused server/UI suites；
-   full server/UI tests；
-   server/UI typecheck 和 build；
-   release/security/source gates；
-   scoped Prettier、ESLint、`git diff --check`；
-   raw code/token/hash/credential signature scan；
-   Git index/ambient-diff ownership review。

测试不得删除、跳过或放宽既有合同。第三次同一路径仍失败时停止局部 patch，转入 auth/session architecture review。

## 本地受控浏览器 L2

只允许正常页面导航、表单输入和点击：

1. 本地创建 `credential=NULL` 的 synthetic identity 和 5 分钟 token。
2. 验证 public `/signin` 仍 restricted。
3. 打开 `/acceptance-login`，用 sensitive form fill 输入一次性码并提交。
4. 验证 `/account`、blank Chatflow、blank Agentflow、empty Document Store metadata PC 链路。
5. UI logout 后再次通过页面提交同一码，必须失败。
6. 检查 address bar、history-visible URL、Web Storage、console、network URL、request/error logs 和 screenshots 不含 code/hash。
7. `1440x900` 执行完整 PC 链路，`1280x800` 验证紧凑 PC 主控件；`390x844` 只验证入口/错误反馈不溢出。
8. Business-object reaper 与 identity/session/token reaper 各执行两次，scoped/global baseline 回到执行前。

本地 L2 不证明 production、controlled-browser connector policy 或 live cleanup。

## 预计文件边界

实施计划可在 source inspection 后进一步缩窄，但不得越过以下责任边界：

-   Modify: `packages/server/src/enterprise/middleware/passport/index.ts`
-   Modify: `packages/server/src/utils/XSS.ts`
-   Modify: `packages/server/src/utils/constants.ts`
-   Modify: `packages/server/src/utils/logger.ts`
-   Modify/Create: acceptance policy/service/controller focused files 及测试
-   Modify: `packages/ui/src/routes/AuthRoutes.jsx`
-   Modify: `packages/ui/src/api/auth.js`
-   Create: `packages/ui/src/views/auth/acceptanceLogin.jsx`
-   Modify/Create: focused UI contract tests
-   Modify: run-scoped production provision/reaper/browser helpers only after local L2
-   Later update after verified facts: `.kiro/plan/*`、current audit/runbook/AGENTS/README

明确不修改 entity、migration、package manifest、lockfile、Provider nodes、Nginx/PostgreSQL 配置或普通 SignIn 行为。

## Clean revision 与 candidate 门禁

本 spec approval 不授权 commit、candidate build 或生产动作。Local L2 全绿后：

1. 对 dirty worktree 做逐 hunk ownership review，只把 acceptance-login source/test/docs contract allowlist 放入 index。
2. 从 staged snapshot 重跑 focused/full/security/release/source/diff/secret gates。
3. 获得 Owner 明确 commit 授权后形成一个原子 revision；不使用 `git add .`。
4. 从 exact clean revision 构建新的 immutable `git-<40 SHA>` candidate，不能重用 `61fffda...`。
5. 完成 archive/manifest、delete/reload、non-root/network-none/read-only/native/browser matrix。
6. Candidate 只达到 local L2；生产提升仍需要新的 exact deployment authorization。

## 生产 L3/L4 验收合同

### L3 preflight

-   Fresh 验证 active production 仍为 `d7bfcd...` exact image/config，不能只使用当前文档或历史 journal。
-   Flowise/PostgreSQL/Nginx IDs、health/restart、private bind、DB read-only、59 migrations、key continuity、Compose/rollback artifacts、residue 和 edge `14/14` 全绿。
-   Candidate archive/config/revision 与本地冻结证据精确匹配。
-   任一 drift 先停止，不上传、不 prepare、不 recreate。

### Flowise-only cutover

-   Root-only artifact transfer、isolated candidate/rollback smoke、prepare journal 先完成。
-   只 recreate Flowise；PostgreSQL、Nginx、migration、CSP、firewall 不变。
-   Candidate postcheck/runtime/edge 全绿后才能 provision synthetic identity。

### PC-first authenticated L4

1. Public `1440x900` `/signin` 仍显示管理入口未公开。
2. 正常访问 `/acceptance-login`，通过受控浏览器 sensitive form fill 提交一次性码。
3. 完成 `1440x900` Account、blank Chatflow、blank Agentflow、empty Document Store metadata 链路。
4. `1280x800` 验证紧凑 PC 工具栏与主操作；mobile 只做入口保底。
5. UI logout 后用同一码重放，必须失败。
6. Browser unexpected console/page/API failures、external origins 和 Provider paths 必须为 0。
7. 禁止 flow execution、upload/vector、Provider、SMTP、member/RBAC。

### Cleanup 与 promotion

-   Document Store/business objects 与 identity/membership/session/token 各执行双 reaper。
-   Global/scoped baseline、fingerprint、59 migrations、key source、container/helper/state/credential residue、logs、private bind 和 edge 再次验证。
-   全部通过才允许 candidate 保持 active，结论限定为上述 PC metadata/UI scope 的 `L4-authorized-live`。
-   Browser policy block、residue、baseline drift、unknown network/Provider path 或关键 UI failure 时，先双清理，再执行 exact post-acceptance rollback 到 `d7bfcd...`；不得写成 promotion complete。

## Evidence grade 与允许结论

| 阶段                                           | 最高等级 | 允许结论                                                |
| ---------------------------------------------- | -------- | ------------------------------------------------------- |
| Spec/source review                             | L1       | 设计已批准、实现未开始                                  |
| Unit/integration/local browser                 | L2       | controlled acceptance login local verified              |
| Fresh production read-only preflight           | L3       | 当前生产与 candidate readiness 只读验证                 |
| 授权 cutover + authenticated browser + cleanup | L4       | 指定 PC metadata/UI scope 的 authorized live acceptance |

禁止外推：

-   普通公开登录已开放；
-   真实用户、SSO、password reset 或 RBAC 已验证；
-   flow execution、upload/vector、Provider/SMTP 已验证；
-   browser policy block 等同于产品失败；
-   candidate health/postcheck 等同于 authenticated L4；
-   未完成 double reaper/postcheck 时 production promotion 已完成。

## 回滚

本功能没有 migration 或持久业务数据转换。Source rollback 只撤回 acceptance-login scoped revision。未来获批部署时，运行态 rollback 使用部署前冻结的 `d7bfcd...` image/config，只 recreate Flowise，不重启 PostgreSQL/Nginx。

回滚前必须尽力执行 scoped double reaper；如果 reaper 失败，journal 标记 incident/rescue，不得用容器回滚掩盖数据库残留。

## 停止条件

-   RED 未以预期原因失败，或旧实现已经满足测试时，先修正测试，不进入 GREEN。
-   任何真实 user/token 能被 acceptance endpoint 匹配，立即阻断 candidate。
-   Raw code/hash 出现在 URL、日志、storage、evidence、screenshot 或 tool output，立即停止并执行 credential cleanup。
-   Controlled browser 不允许 sensitive form fill 时，停止并请求 Owner 手工输入；禁止绕过浏览器策略。
-   Local L2、clean revision、candidate、production deploy 分别使用独立证据和授权，不自动升级。
-   任一生产 residue、fingerprint drift、journal `rescue_failed`、edge regression 或未知外联立即停止并按 rollback/rescue 合同处理。
