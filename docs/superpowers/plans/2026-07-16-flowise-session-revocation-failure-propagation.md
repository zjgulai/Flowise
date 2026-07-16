---
title: Flowise session revocation failure propagation implementation plan
date: 2026-07-16
status: local_l2_complete_release_execution_authorized
design_spec: docs/superpowers/specs/2026-07-16-flowise-session-revocation-failure-propagation-design.md
local_baseline: c165744
production_baseline: 61f248f499a1d5128d0db4c48314baf42bcec5ac
authorization: owner_approved_written_spec_local_implementation_immutable_release_and_success_path_acceptance
evidence_target: L2_fixture_and_local_gates
production_write: false
database_write: false
provider_call: false
live_send: false
deployment: false
merge: false
---

# Flowise Session Revocation Failure Propagation Implementation Plan

## 目标与完成定义

把 approved design 转换为一条可重复、可中断、可审查的 RED→GREEN 实施链：HTTP password change/reset 只有在旧 server sessions 已可靠撤销后才允许开始 credential/token transaction；任一受支持 store 的已知失败都显式传播，且日志与错误不泄露 session、credential 或连接信息。

本批完成必须同时满足：

1. 旧实现上的 focused tests 稳定 RED，并且失败断言对应 spec 中的真实缺口，而不是测试装配错误。
2. 最小实现后同一批 focused tests GREEN；name-only、坏 payload、`DEL=0` 等既有安全行为不回归。
3. full server Jest、server build、focused lint、release/security/source/diff/secret gates 通过，或将无关既有失败以 fresh evidence 单独归因。
4. scoped diff 只包含四个 source、三个 test、approved spec status、本文档与事实源同步；不修改 dependency、lockfile、schema、migration、route、UI 或 Provider node。
5. 结论最高为 L2。历史 E0-D 继续只是 production success-path L4，不外推为 production failure propagation。

## 第一性原理约束

1. **敏感写入必须以撤销成功为前置条件。** 撤销失败时不得启动 user transaction。
2. **等待 pipeline 不等于命令成功。** Redis 每个 `[error, result]` tuple 都必须检查。
3. **运行时 session store 必须与撤销 helper 同源。** fallback MemoryStore 必须显式创建并共享同一实例。
4. **部分撤销不是原子成功。** 任一 batch/callback 失败都返回 typed 500；credential 不变，但已删除 sessions 不回补。
5. **安全跳过只限无归属 payload。** 坏 JSON、null、无 `passport.user.id` 可跳过；store 未注册、unsupported DB 或 store callback/query failure 必须失败。
6. **错误可诊断但不可泄密。** 保留 internal cause，只输出稳定 event/error/store metadata。
7. **不通过长事务包围 session scan。** revoke 完成后才打开 credential transaction。

## 精确文件边界

### Source

-   Modify `packages/server/src/enterprise/middleware/passport/SessionPersistance.ts`
-   Modify `packages/server/src/enterprise/middleware/passport/index.ts`
-   Modify `packages/server/src/enterprise/services/user.service.ts`
-   Modify `packages/server/src/enterprise/services/account.service.ts`

### Tests

-   Create `packages/server/src/enterprise/middleware/passport/SessionPersistance.test.ts`
-   Create `packages/server/src/enterprise/services/user.service.test.ts`
-   Create `packages/server/src/enterprise/services/account.service.test.ts`

### Plans/state

-   Update approved spec frontmatter only for review status.
-   Create this implementation plan.
-   Update `.kiro/plan/{task_plan,progress,findings}.md` as evidence changes.
-   Update current audit/runbook/AGENTS/README only after verified implementation facts exist.

### Explicit exclusions

`LoginSession` entity、migrations、package manifests、`pnpm-lock.yaml`、public routes、UI、email confirmation、CLI password reset、authVersion/generation、Provider/SMTP、production helper 与 deployment 文件均不修改。

## 执行 TODO

### Gate 0 — 恢复、审批与 ownership

-   [x] 读取 root `AGENTS.md`、E0-D audit、`.kiro/plan/task_plan.md` 与 `.kiro/plan/progress.md`。
-   [x] 核验 written spec user approval，并同步 spec status。
-   [x] 核验 branch、HEAD、Git index 与 dirty worktree。
-   [x] 核验四个 source/三个 test target 在本批开始时没有 pre-existing diff。
-   [x] 冻结 production exact `61f248f...`；本批 `production unchanged`。

### Gate 1 — 测试接缝与 RED contract

1. Session helper suite：
    - [x] 用 isolated module state/mocks 初始化 Redis、DB 或 Memory store，不向生产代码增加仅测试使用的全局 reset API。
    - [x] no-store 调用必须 reject typed error；旧实现稳定 RED。
    - [x] unsupported DB type 必须 reject；旧实现稳定 RED。
    - [x] Redis `exec()` 返回 command error tuple 必须 reject，并保留 cause；旧实现稳定 RED。
    - [x] Redis 超过 1000 keys 时，后续 delete batch error 必须 reject；旧实现稳定 RED。
    - [x] Redis all-success 与 `DEL=0` 必须 resolve；旧实现回归合同已通过。
    - [x] MemoryStore 只 destroy target user sessions，保留其他用户；`all`/`destroy` callback error 必须 reject；旧实现因没有显式 initializer 稳定 RED。
    - [x] PostgreSQL/SQLite/MySQL 保留各自 WHERE/parameter，并传播 execute failure；backend expressions 已通过，typed wrapping 稳定 RED。
    - [x] null、坏 JSON、无 user payload 安全跳过；旧实现回归合同已通过。
2. User service suite：
    - [x] password-change revoke reject 时，`startTransaction/save/commit` 均未调用；旧实现稳定 RED。
    - [x] success invocation order 为 revoke → startTransaction → save → commit；旧实现稳定 RED。
    - [x] save/commit failure 时 revoke 仅一次，rollback/release 保持既有合同；旧实现稳定 RED。
    - [x] name-only update 不调用 revoke；旧实现回归合同已通过。
3. Account reset suite：
    - [x] reset-password revoke reject 时，transaction/save/commit 均未调用；旧实现稳定 RED。
    - [x] success invocation order 为 revoke → startTransaction → save → commit；旧实现稳定 RED。
    - [x] save/commit failure 时 revoke 仅一次，rollback/release 保持既有合同；旧实现稳定 RED。
4. RED 命令（Node 24.18.0）：

```bash
PATH=/Users/pray/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --dir packages/server exec jest --runInBand \
  src/enterprise/middleware/passport/SessionPersistance.test.ts \
  src/enterprise/services/user.service.test.ts \
  src/enterprise/services/account.service.test.ts
```

RED 接受标准：失败仅来自 spec 列出的 silent-success/order assertions；syntax、module resolution、mock 初始化错误不计为 RED evidence。

Session helper fresh RED：Jest suite 可编译运行，`13` tests 中 `5` 个既有回归合同通过，`8` 个按设计失败：no-store、unsupported DB、Redis tuple、later batch、DB typed cause 与三条显式 MemoryStore 合同。没有 syntax/module-resolution/mock-init failure。

Service fresh RED：User suite `1/5` 回归通过、`4/5` ordering/failure 精确失败；Account suite 在 test-seam architecture review 后成功进入行为断言，`0/4`，四条均精确证明旧实现为 start/save/commit→revoke 或在 save/commit failure 时根本不 revoke。早期三次 fixture/module-init failure 不计 RED evidence。

### Gate 2 — 最小 GREEN 实现

1. `SessionPersistance.ts`：
    - [x] 新增专用 `SessionRevocationError`，固定 status `500` 与 message `Failed to revoke active sessions`，保留 `cause`。
    - [x] 新增 MemoryStore singleton initializer；返回可直接交给 express-session 的同一 store。
    - [x] 将 Redis、DB、Memory 删除拆成小型 store-specific helpers。
    - [x] Redis 收集目标 keys 后按 1000 分批 delete；要求 `exec()` 返回数组且每个 tuple error 为空。
    - [x] Memory `all()` 与每个 `destroy()` callback error 均传播；只删除匹配 target user 的 sid。
    - [x] missing store 与 unsupported `DATABASE_TYPE` fail closed。
    - [x] public wrapper 将未知底层错误统一包装一次；已是 typed error 时不重复包装。
    - [x] 日志不包含 user/session/key/payload/token/cookie/URL/connection 数据。
2. `passport/index.ts`：
    - [x] 保持 queue Redis 与 supported DB 选择顺序。
    - [x] 对其他既有 implicit fallback 路径显式初始化 MemoryStore。
    - [x] `sessionOptions.store` 与 revocation helper 持有同一实例。
3. `user.service.ts`：
    - [x] 完成全部 validation/hash/safePatch 后计算 `passwordChanged`。
    - [x] password changed 时在 `startTransaction` 前 await revocation。
    - [x] 删除 commit 后的重复 revocation；name-only path 不变。
4. `account.service.ts`：
    - [x] 完成 token/expiry/password/hash 校验与 patch 准备后，在 `startTransaction` 前 await revocation。
    - [x] 删除 commit 后的重复 revocation。
5. 实现纪律：
    - [x] 不新增 dependency/schema/API，不做无关重构或格式化。
    - [x] 不吞 error，不通过删除/skip 测试制造 GREEN。
    - [x] Account test seam 第三次仍失败时已按规则停止并完成 architecture review，随后根因预测验证通过。

### Gate 3 — Focused GREEN 与直接回归

-   [x] 重新运行 Gate 1 exact Jest command；补强 missing/malformed Redis result、`DATABASE_TYPE=default` 与 non-enumerable cause 合同后，最终 `3 suites / 25 tests` 全部 GREEN。
-   [x] 运行既有相邻 auth/session suites；合并 focused run 为 `5 suites / 40 tests` 全通过：

```bash
PATH=/Users/pray/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --dir packages/server exec jest --runInBand \
  src/enterprise/controllers/account.controller.test.ts \
  src/enterprise/middleware/passport/authSecurityPolicy.test.ts
```

-   [x] 运行 focused ESLint；首次只报 3 个 Prettier errors，exact-file format 后 exit `0`：

```bash
PATH=/Users/pray/.nvm/versions/node/v24.18.0/bin:$PATH pnpm exec eslint \
  packages/server/src/enterprise/middleware/passport/SessionPersistance.ts \
  packages/server/src/enterprise/middleware/passport/index.ts \
  packages/server/src/enterprise/services/user.service.ts \
  packages/server/src/enterprise/services/account.service.ts \
  packages/server/src/enterprise/middleware/passport/SessionPersistance.test.ts \
  packages/server/src/enterprise/services/user.service.test.ts \
  packages/server/src/enterprise/services/account.service.test.ts
```

-   [x] Tests 仅使用 `.invalid`/synthetic literals；scoped private-key/credential-URL/provider-key signature scan 无匹配，不依赖真实 user/email/session key。

### Gate 4 — Full local L2 gates

-   [x] Full server Jest：`39 suites / 1035 tests` 全通过：

```bash
PATH=/Users/pray/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --dir packages/server exec jest --runInBand
```

-   [x] Server TypeScript/build：`tsc && rimraf dist/enterprise/emails && gulp` exit `0`：

```bash
PATH=/Users/pray/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --dir packages/server build
```

-   [x] Workspace build：Turbo `6/6` tasks successful，exit `0`；保留既有 Vite dynamic-import/chunk-size warnings，不误写为零 warning：

```bash
PATH=/Users/pray/.nvm/versions/node/v24.18.0/bin:$PATH pnpm build
```

-   [x] 执行已从 repo 确认的 gates：release `19/19`、security `114/114`（0 warning）、release-source silent exit `0`。
-   [x] 执行 tracked `git diff --check`、target allowlist、scoped secret-pattern/trailing-whitespace scan 与 exact-file Prettier check；全部通过。
-   [x] Full gate 未暴露 pre-existing unrelated failure；构建仅保留既有 Vite dynamic/static import 与大 chunk warnings，未把 warning 写成 failure 或零 warning。

### Gate 5 — Diff、自审与原子 staging 决策

-   [x] 已逐文件复核 source/test diff、调用顺序、错误路径、日志字段与 exclusions。
-   [x] 已确认 `pnpm-lock.yaml`、manifest、migration、route/UI/Provider path 没有本批 diff。
-   [x] Git index 保持为空；用户未要求 implementation commit。
-   [x] 本批未 staging/commit；如后续明确要求 commit，只显式 stage 该 concern 的 allowlist，复核 cached name/status/stat/check，不使用 `git add .`。
-   [x] 未 push、未 merge。

### Gate 6 — 事实源同步与 L2 验收

-   [x] 更新 `.kiro/plan/{task_plan,progress,findings}.md`，记录 fresh RED/GREEN/test/build totals。
-   [x] 更新 audit/runbook/AGENTS/README 的当前态；保留 E0-D 历史 success-path 文字，不改写为 failure-path production proof。
-   [x] 精确允许结论：
    -   `session_revocation_failure_propagation=L2_verified`
    -   `http_password_mutation_revoke_before_commit=L2_verified`
    -   `production_success_path=previous_E0-D_evidence_only`
    -   `production_failure_injection=false`
    -   `production unchanged`
-   [x] 禁止结论：跨 store/并发登录强原子、所有密码/邮箱/CLI 入口覆盖、production Redis/DB failure 已验证、已部署或已完成二次浏览器验收。

### Gate 7 — 独立 immutable release 与 success-path acceptance

-   [x] Gate 0-6 已有 fresh evidence；用户后续明确批准 exact-hunk implementation commit、clean-source immutable candidate、production L3、Flowise-only cutover 与 real Chrome success-path acceptance。
-   [~] 先创建单 concern commit，再从 exact commit build candidate，完成 local archive/reload/runtime proof；不得从 ambient dirty worktree 构建。
-   [ ] Production L3、制品双端 hash、rollback/key continuity、Flowise-only cutover、synthetic password-change success path、double reaper 与 fresh postcheck 全部独立取证。
-   [x] Production 不主动注入 DB/Redis failure；merge、Provider/SMTP、migration、现有用户变更仍未授权。

## 回滚与停止条件

-   Source/test 仅为未提交工作区改动时，回滚应使用 exact patch/manual reversal；禁止 `git reset --hard`、`git checkout --` 或 `git clean` 影响其他用户资产。
-   如形成后续 scoped commit，源码回滚只 revert 该 exact commit；没有 migration/data rollback。
-   撤销成功而 credential save 失败会让用户被额外登出，这是设计内 fail-safe 状态，不做 session 回补。
-   新增架构决策、真实秘密、Provider/SMTP、live DB failure injection、migration 或 target path ownership 冲突出现时立即停止。

## 当前边界

计划当前状态：`written_spec_approved=true`、`red_tests_complete=true`、`focused_green=25/25`、`adjacent_green=40/40`、`server_full_green=1035/1035`、`server_tsc_no_emit=pass`、`server_build=pass`、`workspace_build=6/6`、`release=19/19`、`security=114/114`、`evidence_grade=L2_verified_local`、`release_execution_authorized=true`、`production_failure_injection=false`、`production unchanged`、`database_write=false`、`provider_call=false`、`live_send=false`、`deployment_executed=false`、`merge=false`。
