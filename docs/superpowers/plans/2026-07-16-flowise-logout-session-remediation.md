---
title: Flowise logout session termination remediation and production acceptance plan
date: 2026-07-16
status: in_progress
baseline_revision: 449aa34047508866806b6b487e3799115e63302d
candidate_revision: derived_from_scoped_release_commit
authorization: owner_approved_development_test_and_flowise_only_production_cutover
provider_call: false
live_send: false
database_migration: false
merge: false
---

# Flowise Logout Session Termination Remediation

## 目标

修复 authenticated logout 分支的异步时序与 Cookie 清理缺陷，使一次成功退出具备可证明的终态：当前服务端 session 已删除，浏览器中 `connect.sid`、`token`、`refreshToken` 均不存在，重载后仍未认证，且测试产生的身份、membership、session 与 login activity 全部清理。

## 第一性原理约束

1. **成功必须代表终态已经发生。** `200 logged_out` 只能在 `req.logout` 与 `req.session.destroy` callback 均成功完成后返回。
2. **服务端失效与客户端删除缺一不可。** 数据库 session 清零不能代替浏览器 Cookie 删除；反之亦然。
3. **错误不可伪装成成功。** logout 或 destroy 失败时返回明确 `500`，不得继续发送统一 `200`。
4. **失败时仍要缩小攻击面。** 退出入口先对三种认证 Cookie 设置匹配 root path 的过期响应；后续服务端失败仍可观测。
5. **只终止当前会话。** 不新增全设备登出、denylist、schema 或 token versioning。
6. **证据必须来自独立层。** 单元测试证明控制流，真实 Chrome 证明 Cookie jar，数据库只读 checkpoint 证明 session store，reaper 证明测试残留为零。

## 方案比较与决策

### A. Controller 内最小串行化修复（采用）

-   在 controller 内集中定义认证 Cookie 名称和 root-path clear helper。
-   logout 入口统一清理 Cookie。
-   保持现有 `AccountService.logout` 审计调用；authenticated session 路径依次等待 `req.logout`、`session.destroy`。
-   保持现有成功 JSON 与 JWT alternate redirect 合同；保持现有两种失败消息。

优点：最小 diff、无需 dependency/schema、可用单元测试完整覆盖、生产回滚只需恢复前一镜像。

### B. 全局 logout middleware/service（本批不采用）

可复用，但当前没有第二个已证实调用点；扩大认证 surface 和回归范围，不符合最小充分原则。

### C. Token denylist/version 与跨设备撤销（本批不采用）

安全能力更强，但需要持久化模型、过期策略和兼容迁移；不是当前 Cookie 残留根因的必要条件。

## 状态机

```text
request
  -> clear client auth cookies
  -> if no req.user: 200 logged_out
  -> AccountService.logout(user)
  -> if not session-authenticated: redirect /login
  -> await req.logout(callback)
       -> error: 500 Logout failed
  -> await req.session.destroy(callback)
       -> error: 500 Failed to destroy session
  -> 200 logged_out
```

## 文件边界

-   Modify: `packages/server/src/enterprise/controllers/account.controller.ts`
-   Create: `packages/server/src/enterprise/controllers/account.controller.test.ts`
-   Create: `docs/superpowers/plans/2026-07-16-flowise-logout-session-remediation.md`
-   Update as facts change: `.kiro/plan/task_plan.md`, `.kiro/plan/findings.md`, `.kiro/plan/progress.md`
-   Update after live result: existing audit/runbook current-state sections only; do not rewrite historical checkpoints.

Release commit 只包含 controller、对应测试与本设计文档。`.kiro/plan/*` 和其他既有 dirty files 不进入该 commit；不 push、不 merge。

## 完整执行 TODO

### Gate 0 — 真值、授权与回滚冻结

-   [x] 核验 branch、HEAD、dirty worktree、active production exact image/container。
-   [x] 保存 E0-C failure code、Cookie 列表、DB/reaper 与 edge 基线。
-   [x] 明确本批授权仅覆盖 scoped commit、immutable build、Flowise-only cutover、synthetic session acceptance。
-   [x] 排除 Provider、SMTP、migration、业务对象、共享 Nginx/PostgreSQL restart、push/merge。
-   [x] 冻结 rollback target 为当前 `git-449aa340...` exact image/config。

### Gate 1 — RED：失败测试

-   [x] 新增 success test，证明 response 必须等待 logout 与 destroy callbacks。
-   [x] 新增 authenticated success Cookie clear + `200` contract。
-   [x] 新增 logout callback error：`500`、无 destroy、无成功响应、Cookie 仍清理。
-   [x] 新增 destroy callback error：`500`、无成功响应、Cookie 仍清理。
-   [x] 新增 JWT alternate path：三 Cookie 清理并保持 `/login` redirect。
-   [x] 新增 no-user stale-cookie path：三 Cookie 清理并返回 idempotent success。
-   [x] 在旧实现上运行 targeted Jest，保存预期失败证据。

### Gate 2 — GREEN：最小实现

-   [x] 添加常量化 Cookie allowlist 与匹配登录属性的 root-path clear helper。
-   [x] 把 callback API 包装为当前方法内可等待的 Promise。
-   [x] 串行等待 logout、destroy 后才发送成功响应。
-   [x] 保持 AccountService、redirect、成功 body 与现有失败 body 合同。
-   [x] 不新增 dependency、schema、日志中的 token/cookie value 或无关重构。

### Gate 3 — 本地 L2 验证

-   [x] Targeted Jest 全绿并记录 suite/test count。
-   [x] Server full Jest、TypeScript/build 按项目能力执行。
-   [ ] Workspace lint/typecheck/build 与 release/security/source gates 执行；任何既有无关失败单独归因。
-   [x] `git diff --check`、秘密字面量扫描、scoped diff review 通过。
-   [ ] 显式 path staging，仅提交 3 个 release concern 文件；复核 cached diff 与 commit 内容。

### Gate 4 — Immutable candidate

-   [ ] 从新 scoped commit 建立 clean detached source；要求 status clean、HEAD exact。
-   [ ] strict frozen install，前后 lockfile hash 相同。
-   [ ] 构建唯一 `linux/amd64` tag `flowise-chinese:git-<candidate_sha>`。
-   [ ] 校验 OCI revision/source/created、platform、runtime user/CMD 与 Node 版本。
-   [ ] isolated `network=none` + tmpfs SQLite ping smoke；`provider_call=false`。
-   [ ] 生成 deterministic gzip archive、canonical manifest、SHA256/bytes。
-   [ ] 删除唯一 tag 后从 archive reload，再次 inspect 与 isolated smoke。

### Gate 5 — Production L3 preflight

-   [ ] 只读复核 Flowise/Nginx/PostgreSQL IDs、images、health、restart、bind、edge、direct `:3000` negative。
-   [ ] `BEGIN READ ONLY` 核验 totals、migrations=`59` 与无上一 run residue。
-   [ ] 核验 current image/config 与 rollback target 未漂移。
-   [ ] 上传 archive/manifest/helper 后逐项 hash 一致；敏感 helper/credential 文件 mode `0600`。
-   [ ] 任一 drift、unhealthy、hash mismatch 或未知 residue 时停止，不 recreate。

### Gate 6 — Flowise-only L4 cutover

-   [ ] 在 root-only timestamped release/backup 目录保存 current config 与 sanitized metadata。
-   [ ] Remote `docker load` 后比对 candidate image ID/platform/labels。
-   [ ] 先运行 remote isolated ping smoke。
-   [ ] 只 promote Flowise image ref 并 recreate Flowise；不 restart PostgreSQL/Nginx。
-   [ ] 超时、health/restart/edge/DB migration drift 任一失败即恢复旧 config/image 并只 recreate Flowise。

### Gate 7 — E0-C 真实 Chrome/DB 验收

-   [ ] 创建唯一 `.invalid` synthetic owner；记录 provision DB checkpoint。
-   [ ] Chrome 完成 login、protected request、reload、same-context second page、UI logout。
-   [ ] 严格 ledger 必须为 `200/200/200/200/200/401/401`。
-   [ ] logout 后与 reload 后 Cookie jar 中三种认证 Cookie count 必须为 `0`。
-   [ ] local auth storage count 必须从非零降为 `0`，页面保持登录表单。
-   [ ] DB session count 必须 `1 -> 0`；migrations/fingerprints 不漂移。
-   [ ] unexpected console error/warning/pageerror/API failure/external origin/provider path 必须为 `0`；仅允许已经冻结的两个 CSP hash。

### Gate 8 — Cleanup、视觉与文档收口

-   [ ] 浏览器 runner finally 执行 reaper，随后独立执行第二次 reaper。
-   [ ] Fresh read-only postcheck：identity/membership/session/login activity/resource/helper/credential residue 全为 `0`。
-   [ ] Flowise candidate healthy/restart `0`；Nginx/PostgreSQL IDs 不变；edge/public-3000 contract 不变。
-   [ ] 对关键截图做目视检查并记录 SHA256；无 overflow、broken image 或错误页面。
-   [ ] 更新 findings/progress/task plan 与 audit/runbook 当前态；保留旧失败证据，不改写历史。
-   [ ] 最终 `git status`/`git diff --check`/文档一致性检查，明确未测自然 TTL 与所有排除范围。

## 验收矩阵

| 层级 | 必须通过                                                                | 不能外推                                             |
| ---- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| L1   | 设计、RED/GREEN contract、静态 diff                                     | 生产行为                                             |
| L2   | Target/full tests、build、immutable archive/reload/smoke                | 生产 Cookie/DB                                       |
| L3   | 当前生产只读 topology/DB/edge/no-drift                                  | 已部署                                               |
| L4   | Flowise-only cutover、real Chrome Cookie=0、DB session=0、double reaper | 自然 TTL、跨设备 logout、Provider/SMTP、完整业务恢复 |

## 停止与回滚条件

-   RED 不能稳定复现旧缺陷，停止修改并重新定位。
-   第三次同一路径验证仍失败，停止叠 patch，重审 controller/session/auth architecture。
-   本地 gate、candidate identity、archive reload 或 production preflight 任一失败，不进入下一层。
-   Cutover 后 Flowise unhealthy、restart 增加、edge 回归、migration drift 或 unexpected external/provider path，立即单 Flowise rollback。
-   E0-C 失败但 runtime 稳定时先 reaper 并保留 candidate；只有产品健康/数据完整性失败才自动 rollback，Cookie 验收失败记录为 acceptance failure 后再决定修复。

## 当前边界

执行中保持：`provider_call=false`、`acceptance_initiated_provider_call=false`、`live_send=false`、`migration_up_executed=false`、`merge=false`。只有 Gate 6 开始后才可声明 `production_write=true`；只有 Gate 7 创建 synthetic identity 后才可声明 `production_database_write=true`，且必须以 Gate 8 residue=`0` 收口。自然 TTL 保持 `not_tested`。
