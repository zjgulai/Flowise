---
title: Flowise session expiry and multi-device revocation acceptance design
date: 2026-07-16
status: approved_for_execution
baseline_revision: 61f248f499a1d5128d0db4c48314baf42bcec5ac
authorization: owner_approved_synthetic_production_session_and_password_change_acceptance
provider_call: false
live_send: false
database_migration: false
deployment: false
merge: false
---

# Flowise Session Expiry And Multi-Device Revocation Acceptance

## 目标

在不修改真实用户、不调用 Provider/SMTP、不迁移数据库、不部署新镜像的前提下，分别证明以下现有合同：

1. PostgreSQL session store 的生产有效期限及过期拒绝行为。
2. 普通 logout 只终止当前 browser session，不误伤另一设备。
3. synthetic 用户修改密码后，已有的安全事件路径会撤销该用户全部 server sessions。
4. 所有测试身份、membership、session、login activity、helper 与 credential residue 最终为零。

## 第一性原理

认证生命周期包含三个独立时钟，任何一个都不能替代另外两个：

-   `connect.sid` 指向 server-side session；当前 cookie 没有 `maxAge`，属于 browser-session cookie。
-   access JWT 由 `JWT_TOKEN_EXPIRY_IN_MINUTES` 控制。
-   refresh JWT 由 `JWT_REFRESH_TOKEN_EXPIRY_IN_MINUTES` 控制。

当前 production 使用 `connect-pg-simple@10.0.0`，middleware 未显式设置 store `ttl`。该 exact dependency 在 cookie 无 `maxAge` 时把 DB session TTL 设为 1 天；store `get` 会拒绝 `expire < now` 的 row，物理删除则由独立 prune 周期完成。因此必须分别记录：

-   configured DB expiry delta；
-   protected request 是否被拒绝；
-   expired row 是否仍物理存在；
-   prune/reaper 是否完成最终清理。

该 store 的 `touch` 会在 session request 后把 DB `expire` 重新推进一个 TTL，因此 production DB TTL 是 sliding server-side expiry；`rolling=false` 只表示响应不持续重发 browser cookie，并不关闭 store touch。时间加速后必须保持 D context 完全 idle，直到唯一一次最终 protected probe，避免验收请求自身先续期。

普通 logout 的设计语义是 current-session termination。`destroyAllSessionsForUser` 只由 password reset 或 authenticated password/email security change 调用。双设备测试的正确成功条件不是“普通 logout 后所有设备都 401”，而是 current-session isolation 与 security-event global revocation 各自符合合同。

## 方案比较

### A. 分层加速验收（采用）

-   L2 使用 exact `connect-pg-simple@10.0.0` 与隔离 PostgreSQL fixture，把 TTL 缩短到数秒，证明 active -> logically expired -> pruned。
-   L3/L4 从 production synthetic session row 只读获取实际 expiry delta，并只对该 row 做一次受保护的时间加速。
-   L4 使用多个独立 Chrome contexts 验证普通 logout 隔离和 synthetic password change 全会话撤销。

优点是一个执行窗口内可完成、不会遗留 24 小时测试账号，且每个结论有独立证据标签。限制是不能声明“production 已真实等待完整 24 小时”。

### B. 24 小时 production soak（不采用）

保留 synthetic identity/session 约 24 小时后再请求并清理。墙钟证据更强，但长期遗留 credential、身份和 session，增加运维与清理风险。

### C. 先新增 logout-all API / 可配置 TTL（不采用）

这会改变产品语义、配置合同和部署面，不是验证当前实现所必需；若产品后续需要用户主动“退出所有设备”，应另建 feature spec。

## 执行架构

### 1. Exact-package TTL fixture

-   使用本机已有 pinned PostgreSQL 16 image、临时 internal Docker network、tmpfs 数据目录和无 host port 配置。
-   Node fixture 使用当前 lockfile 中的 `connect-pg-simple@10.0.0`，设置 `ttl=2s`、关闭自动 prune。
-   写入一条 synthetic session，立即 `get` 必须命中；等待超过 2 秒后 `get` 必须返回空，而 physical row 仍存在；显式 prune 后 physical row 必须为零。
-   fixture 容器、network、volume 与临时文件最终全部清理；`database_write=local-test-only`。

### 2. Production multi-context state machine

使用唯一 `.invalid` synthetic owner、advisory lock、root-only journal 和 A/B/C/D 四个独立 Chrome contexts：

| Phase              | 动作                                                                                | Browser/API 判据                                                   | DB 判据                                                       |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| provision          | 创建 synthetic owner/membership                                                     | 无认证 Cookie                                                      | session rows=`0`                                              |
| dual_login         | A、B 分别登录                                                                       | A=`200`、B=`200`；各自 auth cookies=`3`                            | active session rows=`2`                                       |
| current_logout     | A 执行 UI logout                                                                    | A protected=`401`、A cookies=`0`；B protected=`200`、B cookies=`3` | active rows=`1`                                               |
| second_pair        | C 使用旧密码登录                                                                    | B=`200`、C=`200`                                                   | active rows=`2`                                               |
| global_revoke      | B 通过 authenticated password-change path 修改 synthetic password                   | password update=`200`；B/C protected=`401`；旧密码 login=`401`     | active rows=`0`                                               |
| relogin            | D 使用新密码登录                                                                    | D protected=`200`；auth cookies=`3`                                | active rows=`1`                                               |
| expiry_baseline    | 不触碰 D session，仅只读 DB/JWT metadata                                            | 只输出 access/refresh `exp-iat` delta，不输出 token                | DB expiry delta 接近 exact store 1 天默认值                   |
| accelerated_expiry | 仅把 D 对应 synthetic row 的 `expire` 调整为 `now + 5s`，随后保持 context 完全 idle | 超时后执行唯一一次 D protected probe=`401`，JWT 本身仍在有效期     | active rows=`0`；expired physical row 可暂存至 prune/reaper   |
| cleanup            | finally reaper + 独立第二次 reaper                                                  | credential files absent                                            | 全部 scoped residue=`0`，baseline/fingerprint/migrations 恢复 |

所有密码只存在于 `0600` credential file 和 Playwright 进程内存中，不通过 CLI argv、日志、截图、journal 或状态 JSON 输出。Session ID 与 JWT 原文也不得输出；只允许记录 count、布尔值和 expiry delta。

### 3. Production time acceleration boundary

只允许在以下条件全部满足时更新时间：

-   identity email/run ID 精确匹配本 run；
-   synthetic user active session row 恰好为 `1`；
-   row 的 passport user ID 精确等于 synthetic user ID；
-   baseline users/memberships/resources/migrations 与 preflight 一致；
-   update 使用 transaction、affected rows 必须精确为 `1`。

该证据标记为 `production_session_expiry_time_accelerated=true`、`production_natural_24h_elapsed=false`。它证明 production store/request-path 的过期判定，不证明完整 24 小时墙钟等待。

## Fail-closed 与清理

-   任一 phase 的 session count、status、Cookie count、JWT delta、expiry delta 或 affected-row count 不精确即停止晋级。
-   意外 Provider path、external HTTP origin、console error hash、migration drift、container drift 或 baseline residue 立即失败。
-   password update 成功后即使浏览器失败，reaper 仍按 user ID 删除 synthetic sessions、login activity、memberships 和 identity。
-   不修改 baseline owner、现有 credential、organization/workspace/role、真实业务对象或 production TTL 配置。
-   不 restart/recreate Flowise、PostgreSQL、Nginx；不 push、不 merge。

## 验证层级与允许结论

| 证据                          | 最高等级      | 允许结论                                                      |
| ----------------------------- | ------------- | ------------------------------------------------------------- |
| exact-package 短 TTL fixture  | L2            | exact store 的 expiry/prune 机制通过                          |
| production row expiry delta   | L3            | 当前 production synthetic session 的 configured DB TTL 已观测 |
| 双 Chrome current logout      | L4            | 普通 logout 只撤销当前 session，另一 session 保持有效         |
| synthetic password change     | L4            | 已有安全事件路径撤销该 synthetic user 全部 sessions           |
| accelerated production expiry | L4-with-label | production store/request path 拒绝已到期 row                  |

禁止结论：`production_natural_24h_elapsed=true`、存在用户可见 `logout-all` 功能、所有认证策略/SSO 均已覆盖、跨设备 token denylist 已实现、完整认证产品 E2E 已完成。

## 文件边界

-   Create: `docs/superpowers/specs/2026-07-16-flowise-session-expiry-multidevice-design.md`
-   Create under ignored `tmp/`: exact-package TTL fixture、multi-context Playwright/remote/outer runner 及其 contract tests。
-   Reuse and minimally extend under ignored `tmp/`: synthetic identity/reaper helper；不覆盖历史 evidence。
-   Update after verified facts: `.kiro/plan/task_plan.md`, `.kiro/plan/findings.md`, `.kiro/plan/progress.md`, current audit/runbook sections。
-   No production source/config/dependency/schema change is planned。若 contract test 暴露产品缺陷，停止 production execution，另建修复 spec。
