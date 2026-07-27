---
title: Flowise 受控浏览器验收本地内存态 Harness 补充设计
date: 2026-07-22
status: approved_with_clarification_a_pending_implementation_authorization
amends: docs/superpowers/specs/2026-07-22-flowise-controlled-browser-acceptance-login-design.md
source_baseline: 1e8c291cbf5b43ff6a0cd6e2f8da824a03db751a
production_baseline: d7bfcd
authorization: owner_approved_scheme_a_clarification_a_and_single_file_followup_commit
clarification_a_approved: true
evidence_grade: L1_source_and_design_review
local_runtime_write: false
production_write: false
provider_call: false
deployment: false
merge: false
---

# Flowise 受控浏览器验收本地内存态 Harness 补充设计

## 1. 结论

采用方案 A：在一次性、本地、仅监听 loopback 的同源反向代理中提供内存态验收 Harness。Harness 驱动真实 `/acceptance-login` 页面完成首次登录和同码重放，但不把原始 code 交给模型、浏览器控制工具、命令行、URL、日志、持久化存储、剪贴板、截图或证据文件。

本补充设计只解决当前受控浏览器缺少 `browserAuth` 能力时的本地 L2 验收阻塞。它不改变产品登录协议，不构成生产 L4 验收，不授权实现、运行、候选构建或生产部署。

## 2. 范围与不变量

### 2.1 本次补充的唯一范围

-   补充原设计中 Task 7 的本地 secret-entry 驱动方式。
-   保持真实 `/acceptance-login` UI、真实登录 API、真实 session/cookie、一次性 CAS 消费和真实 logout 链路不变。
-   约束 Harness 的端口、身份、secret、浏览器、日志、证据与清理边界。

### 2.2 原设计保持不变

-   临时身份必须是 run-owned synthetic identity。
-   acceptance credential 必须是短时、单次、原子消费。
-   正常认证入口保持受限，Harness 不能恢复或放宽普通 `/signin` 登录。
-   不执行 chatflow/agentflow，不上传文档，不调用 provider，不写生产。
-   所有运行时资源都必须由双重 reaper 清理并以零残留为完成条件。

### 2.3 明确排除

-   不把 raw code 传给 `fill`、`type`、clipboard、raw CDP、shell、HTTP query、fragment 或环境变量。
-   不注入 Flowise session，不伪造 cookie，不直接跳转 `/account` 绕过认证。
-   不使用独立 Playwright/Cypress 或另一个浏览器替代已批准的受控浏览器。
-   不把本地 Harness 暴露到 LAN、容器公网接口或生产域名。
-   不把本地 L2 结果表述为 candidate、deployment 或 production L4 证据。

### 2.4 澄清 A：identity URL 边界

当前未改变的产品合同要求 Account 页面通过 `GET /api/v1/user?id=<synthetic-user-id>` 读取用户，其他受保护页面也可能在既有产品 API 的 URL 或 payload 中传递 opaque synthetic user、organization、workspace 或 resource ID。因此，“所有 URL 均不得包含 identity”的绝对表述不可实现，也不能以跳过 Account 或重写 ID alias 的方式规避。

本设计采用以下精确边界：

-   raw code 与 digest 仍绝对禁止出现在任何 URL 的 path、query 或 fragment 中。
-   synthetic email 仍绝对禁止出现在任何 URL、工具输出、模型上下文、日志或证据中。
-   Harness/helper URL 绝对禁止包含 synthetic email 或 user、organization、workspace、resource ID。
-   既有产品 API 可按当前未改变的产品合同，在浏览器与 Flowise 之间以内存态传递 opaque synthetic ID；不得为 Harness 新增 identity-bearing 产品 URL，也不得把 ID 改写成 proxy alias。
-   Controller、模型、浏览器工具输出、helper、Flowise/proxy 日志与证据不得暴露或保存这些 ID，亦不得暴露或保存包含这些 ID 的完整产品 URL。
-   Proxy 只在内存中流式转发既有产品 URL；不得记录 query 或 fragment，只按冻结的静态 pathname allowlist 统计非敏感计数。

此澄清不是记录、输出或扩大使用 synthetic identity 的授权；它只承认真实产品页面已经存在的 opaque ID 传输合同。

## 3. 方案选择

### 3.1 采用：同源反向代理 + 页面内存态 Harness

选择原因：

-   raw code 可在浏览器页面内部生成并只保留在 closure 与真实 masked input 的短暂内存中。
-   受控浏览器只点击固定、非敏感控件，不需要接收或输入 secret。
-   首次登录、session 建立、页面访问、logout 和重放拒绝仍经过真实产品链路。
-   Harness 与产品源码、生产环境和长期凭据相互隔离。

### 3.2 不采用：产品级 device approval 流程

该方案会新增产品协议、状态机、权限面和生产攻击面，超出本地验收阻塞的最小修复范围。若未来需要生产 L4 的无人值守认证，应另立设计和威胁模型。

### 3.3 不采用：普通自动填充或会话注入

普通自动填充会把 secret 暴露给模型或工具参数；clipboard/raw CDP 会引入额外泄露通道；session/cookie 注入会绕过被验收的真实认证链路，因此全部禁止。

## 4. 运行时架构

### 4.1 进程与端口

一次验收运行包含：

1. Flowise backend：绑定 `127.0.0.1:<backend-port>`，只接受本机连接。
2. Harness proxy：绑定 `127.0.0.1:<proxy-port>`，向浏览器提供唯一测试 origin。
3. 受控浏览器：只访问 `http://127.0.0.1:<proxy-port>`。

`APP_URL`、CORS 与 cookie origin 必须指向 proxy origin。正常页面和 API 由 proxy 转发至 Flowise；Harness 仅占用以下 run-owned 路由：

-   `GET /__flowise-acceptance/harness`
-   `POST /__flowise-acceptance/provision`

端口必须在运行前动态确认未占用。任何端口冲突都必须发生在创建 synthetic identity 之前并立即 fail closed。

### 4.2 Proxy 安全边界

-   只监听 `127.0.0.1`，不得监听 `0.0.0.0` 或 `::`。
-   只接受启动时冻结的 exact `Host`，拒绝其他 Host 与 DNS rebinding 形态。
-   Harness 响应使用 `Cache-Control: no-store`。
-   Harness 使用逐响应 nonce 的严格 CSP；只允许同源脚本、连接和 frame，禁止外部资源、`object`、`base` 与第三方 frame。
-   Proxy 不记录 request body、cookie、authorization header 或 response body。
-   Proxy 不记录 query、fragment 或完整产品 URL；产品请求只按冻结的静态 pathname allowlist 计数。
-   Helper cookie 在转发至 Flowise 前必须剥离。
-   非白名单 method/path、畸形 body 和未知 route 必须固定响应并不泄露内部状态。

### 4.3 同源 iframe

Harness 页面包含指向真实 `/acceptance-login` 的同源 iframe。由于页面和 iframe 共享 proxy origin，Harness 脚本可以操作真实登录表单，但服务端仍由真实 Flowise 登录 API 校验并消费 credential。

这不是认证绕过：Harness 只替代“人或工具输入 secret”这一动作，不替代服务端 credential 校验、CAS、session 建立、cookie、路由保护或 logout。

## 5. Secret 生命周期

### 5.1 页面内生成

-   raw code 由 Harness 页面使用 Web Crypto `crypto.getRandomValues` 生成。
-   编码为无 padding 的 base64url，长度固定为 43 个字符，对应 32 字节随机值。
-   raw code 从不进入 provisioning helper 逻辑、controller、模型上下文或浏览器控制参数。
-   raw code 的语义生命周期只包含页面 closure、真实 masked password input、真实登录 POST body 与 Flowise 请求内存；同源 proxy 只做不落盘、不解析、不记录 body 的字节流转发。

### 5.2 Digest 计算

页面使用 Web Crypto 对以下精确 UTF-8 字节序列计算 SHA-256：

```text
flowise-acceptance:v1\0<raw-code>
```

页面只把 64 位小写十六进制 digest 发送给本地 provisioning endpoint。Helper 将其存为：

```text
acceptance:v1:<digest>
```

Helper 不得对 digest 再次 hash，也不得接收 raw code。

### 5.3 Provisioning 授权

首次加载 Harness 时，proxy 生成高熵、run-owned、内存态 helper nonce，并通过以下 cookie 绑定请求：

-   `HttpOnly`
-   `SameSite=Strict`
-   `Cache-Control: no-store`
-   `Path=/__flowise-acceptance`
-   运行结束或 helper 退出即失效

`POST /__flowise-acceptance/provision` 必须同时满足：

-   exact method 为 `POST`；
-   `Origin` 与 proxy origin 完全一致；
-   helper cookie 与内存 nonce 常量时间匹配；
-   body 只包含 `{ "digest": "<64 lowercase hex>" }`；
-   本次运行尚未 provision；
-   目标是 helper 内存中绑定的 exact synthetic user ID；
-   用户 active、现有 credential 为 NULL、临时 token 为 NULL；
-   CAS update 的 affected row 恰好为 1。

成功时设置 5 分钟过期时间。任一条件不满足都不得覆盖 credential，不得返回用户 ID、邮箱、digest 或数据库细节。

## 6. 浏览器如何驱动真实 UI

### 6.1 首次登录

1. 受控浏览器打开 Harness，验证页面是固定非敏感状态。
2. 受控浏览器点击“开始首次登录”。按钮点击本身不携带 secret。
3. Harness 页面生成 raw code、计算 digest 并完成一次 provisioning。
4. Harness 脚本定位 iframe 中真实 `/acceptance-login` 的 masked input。
5. Harness 脚本设置真实 input value，派发与现有 React 表单兼容的 `input`/`change` 事件。
6. Harness 脚本点击真实 submit 控件。
7. 真实 UI 调用真实登录 API；服务端完成校验、CAS 消费、session/cookie 建立和页面导航。
8. Harness 只向 controller 显示固定结果状态，例如 `first_login_succeeded` 或 `first_login_failed`。

从 raw code 写入 masked input 到产品 UI 清空字段之前，禁止 snapshot、screenshot、DOM dump、console dump 或浏览器调试读取。

### 6.2 登录后页面验证

首次登录成功后，受控浏览器进入正常产品页面并以只读方式验证：

-   `/account`
-   `/chatflows`
-   `/agentflows`
-   `/document-stores`

不得创建、执行、上传、删除或触发 provider。然后必须通过真实 UI 执行 logout，并确认受保护页面重新不可访问。

### 6.3 同码重放

1. Harness 在 closure 中保留首次使用的 raw code，直到 replay 完成。
2. UI logout 后，受控浏览器返回 Harness 并点击“使用同一码重放”。
3. Harness 重新加载真实 `/acceptance-login` iframe。
4. Harness 把同一个 raw code 写入真实 masked input 并提交；不得再次 provision。
5. 服务端必须通过真实认证链路拒绝已消费 credential。
6. 产品 UI 清空字段后，Harness 才显示固定 `replay_rejected` 状态。
7. Harness 随即释放 raw code 引用并锁死所有后续 provision/submit 控件。

如果同码重放意外成功，任务立即判定为 critical failure，不得继续页面验收或降级解释。

## 7. 禁止通道与可观察性

| 通道                 | 约束                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller/模型      | 永远不接收 raw code、digest、synthetic email 或 synthetic user/org/workspace/resource ID                                                              |
| 浏览器工具参数与输出 | 只包含固定 helper URL、固定产品 pathname、固定按钮标签、布尔值/计数和非敏感断言；不得包含 identity-bearing 产品 URL                                   |
| Secret URL           | 任何 path、query、fragment 均不得包含 raw code 或 digest                                                                                              |
| Harness/helper URL   | 不得包含 synthetic email 或 user/org/workspace/resource ID                                                                                            |
| 既有产品 API         | 可按未改变的产品合同以内存态传递 opaque synthetic ID；不得新增 identity-bearing URL、alias rewrite、工具回显或证据记录                                |
| 日志                 | Helper、proxy 与 Flowise 只输出固定事件名、pathname allowlist 计数与成功/失败；不输出 body、cookie、query、fragment、ID 或 identity-bearing 完整 URL  |
| 持久化存储           | Harness 不使用 localStorage、sessionStorage、IndexedDB、Cache API 或文件                                                                              |
| Clipboard            | 完全禁止                                                                                                                                              |
| Raw CDP              | 完全禁止                                                                                                                                              |
| DOM/Snapshot         | secret 存在于 input 时禁止读取；只在生成前或产品 UI 清空后检查                                                                                        |
| Screenshot           | secret 存在于 input 时禁止截图                                                                                                                        |
| Network              | raw code 只允许出现在真实 acceptance login POST body；digest 只允许出现在 loopback helper POST body；opaque synthetic ID 只按既有产品合同在内存中转运 |
| 证据文件             | 只保存固定状态、pathname 计数、端口归零结果和非敏感 artifact hash                                                                                     |

Helper 页面源代码必须没有 secret 字面量、用户 identity、console 输出或持久化 API。浏览器不得检查 storage 内容或网络 URL；验证方式是静态检查 Harness 源、只含 pathname 的 proxy 计数与固定运行时事件。进入 synthetic identity 流程前，必须先用公开、非身份 fixture 证明浏览器工具只返回固定布尔值/计数且不会自动回显 request URL；否则 fail closed。

## 8. 视口与交互矩阵

### 8.1 1440×900：完整主链路

-   `/signin` 保持受限。
-   Harness 首次登录成功。
-   `/account`、`/chatflows`、`/agentflows`、`/document-stores` 只读验证。
-   真实 UI logout 成功。

### 8.2 1280×800：登录页结构

-   直接访问 `/acceptance-login`。
-   检查标题、输入、提交、错误区和键盘焦点路径。
-   不生成或输入 raw code。

### 8.3 390×844：重放拒绝与移动端可达性

-   在移动视口执行同码重放。
-   只在产品 UI 已清空字段后读取固定错误状态。
-   验证错误信息可见、控件可达、无阻塞性横向溢出。

移动端仅作为可达性和错误路径验收，不改变“重 PC、轻移动端”的发布优先级。

## 9. Fail-closed 矩阵

| 失败条件                             | 必须行为                            |
| ------------------------------------ | ----------------------------------- |
| Proxy/backend 端口冲突               | 创建 identity 前停止                |
| Helper cookie 缺失或不匹配           | 固定拒绝；数据库零写入              |
| Origin/method/body/digest 不合法     | 固定拒绝；数据库零写入              |
| 重复 provision                       | 拒绝；不得覆盖 credential           |
| CAS affected row 不为 1              | 失败；不得继续登录                  |
| iframe 不同源或 DOM contract 不匹配  | 提交前停止；不得启用其他输入路径    |
| 首次登录失败                         | 不执行 replay；进入清理             |
| Replay 意外成功                      | critical failure；立即进入清理      |
| 任意 forbidden channel 观察到 secret | 立即失败并清理                      |
| Helper/proxy/Flowise 异常退出        | 双重 reaper 清理所有 run-owned 资源 |
| 清理断言不为零                       | Task 7 失败，不得声称通过           |

不存在自动 fallback。尤其不得在 Harness 失败后改用 clipboard、普通 `fill`、raw CDP、session injection 或其他浏览器。

## 10. 实施前验证计划

实现计划必须至少包含以下红绿验证：

1. 使用固定、非敏感 digest fixture 验证 helper 的 method/origin/cookie/body/CAS fail-closed contract。
2. 静态检查 Harness 源没有 console、storage、clipboard、外部资源、secret URL 拼接或 identity-bearing helper URL。
3. 验证 proxy 仅监听 loopback，helper cookie 不会转发至 Flowise，且只记录静态 pathname allowlist 计数、不记录 query、fragment 或完整 URL。
4. 在创建 synthetic identity 前，使用公开非身份 fixture 验证受控浏览器工具仅回传固定布尔值/计数，不自动回显 request URL；随后验证全部工具调用记录不含 raw code、digest、synthetic email、opaque synthetic ID 或 identity-bearing 产品 URL。
5. 验证首次登录经过真实 `/acceptance-login` 与真实 session 建立。
6. 验证 logout 后受保护页面不可访问。
7. 验证同码 replay 被真实服务端拒绝。
8. 验证三个视口矩阵且 secret 存活阶段没有 snapshot/screenshot。
9. 验证没有 create/upload/execute/provider 请求。
10. 验证双重 reaper 后 identity、membership、session、credential、process、port、tab 和 run-owned tmp 全部归零。
11. 验证运行前后产品源码 diff 不变。

任何步骤只能形成本地 L2 证据。真实生产 L4 仍需独立、生产安全的 secret delivery 设计、独立授权和生产只读/写入边界确认。

## 11. 清理顺序

正常或异常路径都执行同一清理协议：

1. 若 session 仍有效，先走真实 UI logout。
2. 完成或记录 replay 结果；不得为完成 replay 延迟 critical failure 清理。
3. Reaper pass 1：按 exact run-owned ID 删除 session、credential、membership 与 synthetic identity。
4. 停止 Harness proxy 和 Flowise runtime。
5. 关闭 run-owned tab，恢复浏览器视口与页面状态。
6. Reaper pass 2：再次验证并删除残余数据库实体。
7. 断言监听端口、子进程、临时目录、helper nonce 与浏览器 tab 均为零。
8. 删除 run-owned 临时文件。
9. 检查产品源码没有 Harness 运行产生的修改。

任一清理项不能证明为零时，整个 Task 7 不通过。

本设计假设本机用户态与受控浏览器进程未被攻陷。对已经能读取浏览器内存、修改本机进程或直接访问验收数据库的攻击者，不把 Harness 描述为额外安全边界；若该假设不成立，必须停止验收并重建可信环境。

## 12. 完成标准

只有同时满足以下条件，方案 A 的本地实现才可判定为 L2 通过：

-   raw code 只存在于 Harness closure、真实 masked input、真实登录 POST body、proxy 的瞬时字节流与 Flowise 请求内存中；
-   raw code 与 digest 不出现在任何 URL，synthetic email 不出现在任何 URL；
-   Harness/helper URL 不含 synthetic email 或 user/org/workspace/resource ID；
-   既有产品 API 只按未改变的产品合同以内存态传递 opaque synthetic ID，proxy 不记录 query/fragment/完整 URL 且不做 alias rewrite；
-   controller、模型、工具参数与输出、日志、存储、剪贴板、截图和证据文件均不含 secret、synthetic email、opaque synthetic ID 或 identity-bearing 产品 URL；
-   provisioning 只接收 digest，并以 exact run-owned identity 和单次 CAS 约束写入；
-   首次登录真实成功，session 和受保护页面真实可用；
-   logout 真实成功；
-   同码 replay 由真实服务端拒绝；
-   PC 主链路和规定的三视口矩阵通过；
-   没有 create/upload/execute/provider 调用；
-   双重 reaper 后所有 run-owned 资源为零；
-   产品源码在运行前后没有 Harness 相关 diff。

## 13. 后续门禁

Owner 已批准原书面规格、implementation plan 与澄清 A。本次只授权更新并单文件提交本 amendment spec；提交后仍停在实现授权门禁。只有 owner 复核更新后的规格并明确授权 implementation plan Task 0–8，才可创建 `$RUN_ROOT`、写入本地 SQLite、启动本地 runtime 或进行受控浏览器验收。

以下事项仍未授权：

-   Harness 实现或运行；
-   synthetic identity 或本地数据库写入；
-   candidate build/commit；
-   push、PR、merge；
-   生产连接、生产写入、二次部署或生产浏览器验收。
