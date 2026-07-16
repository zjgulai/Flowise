---
title: Flowise session revocation failure propagation design
date: 2026-07-16
status: approved_design_pending_written_spec_review
local_source_baseline: 6baadcdcacb6d949814d63180d31f87ae61d312e
production_baseline: 61f248f499a1d5128d0db4c48314baf42bcec5ac
authorization: owner_approved_design_option_a
evidence_grade: L1_source_and_exact_dependency_contract
production_write: false
database_write: false
provider_call: false
live_send: false
deployment: false
merge: false
---

# Flowise Session Revocation Failure Propagation

## 目标

把 HTTP password change/reset 的全会话撤销从“成功路径可用、失败路径可能形成部分成功”收紧为可测试的 fail-closed 合同：只有确认已有 server sessions 已撤销后，才允许提交新的 credential/token 状态。

本设计不把局部修复描述为强原子 revocation。它解决的是已知错误传播和敏感写入顺序问题；Redis scan/delete 与并发登录之间的竞态仍需后续 revocation generation 架构才能消除。

## 当前事实与证据边界

-   Production E0-D 已以 synthetic 用户证明当前 PostgreSQL success path：password change 后既有 sessions 清零。该证据是 L4 success-path proof，不证明 DB failure propagation。
-   当前 `destroyAllSessionsForUser` 的顶层 catch 已重新抛出异常；本批不是“补 rethrow”。
-   `EXPIRE_AUTH_TOKENS_ON_RESTART=true`、`mariadb` initializer 的未实现分支或未知 DB fallback 会让 express-session 内部创建默认 MemoryStore，但 helper 看不到该实例；当前 no-store 分支只 warning 并 resolve。
-   `packages/server` 锁定 `ioredis@5.3.2`。其 pipeline Promise 返回逐命令 `[error, result]`；当前代码只等待 `exec()`，未检查每个 error tuple。
-   `UserService.updateUser` 与 `AccountService.resetPassword` 都在 credential/token transaction commit 后才撤销 sessions。撤销失败时 API 会报错，但已提交的敏感状态不能回滚。
-   当前 failure-path 最高证据为 L1 source/exact-dependency contract；尚未运行 RED failure injection，不能写成已复现或已修复。

## 范围

### 本批包含

1. 让现有 fallback MemoryStore 成为显式、可被 session helper 访问的同一实例。
2. 为 Redis、PostgreSQL、SQLite、MySQL、MemoryStore 和 missing/unsupported store 定义一致的成功/失败合同。
3. 检查 Redis pipeline 每条删除命令的 error tuple。
4. 把 authenticated HTTP password change 与 reset-password 改为 revoke-before-commit。
5. 增加 focused Jest failure/order tests，并执行 server/full local gates。

### 本批不包含

-   `confirmEmailChange`：当前 `updateUser.safePatch` 会丢弃 email/tempToken/tokenExpiry，是独立产品缺口。
-   CLI `user --email --password`：该入口不启动 passport/session store，也不撤销已有 sessions，需要独立管理面设计。
-   `authVersion`、revocation generation、outbox、token denylist 或每请求 DB 回查。
-   database migration、entity/schema 修改、新 dependency 或 public API 变化。
-   Provider/SMTP 调用、真实邮件、production DB failure injection、部署、merge 或生产验收。

上述独立问题进入后续 E0-F；E0-E 完成后也不得宣称“所有密码/邮箱入口已覆盖”。

## 方案比较

### A. 先撤销、后提交（采用）

-   在全部输入、token、expiry、旧密码、新密码和 hash 校验完成后撤销 sessions。
-   撤销成功后才开始 credential transaction。
-   任一 store failure 阻止敏感写入并返回稳定 500。

优点：无 schema/dependency/API 变化；直接消除“已知撤销失败仍提交密码”的窗口。代价：store 故障时改密/重置不可用；撤销成功后若 DB 写失败，用户会被额外登出，但密码保持不变。

### B. 提交后撤销并做补偿（拒绝）

撤销失败后恢复旧 credential/token/email。补偿自身可能失败，token 恢复会引入新风险，Stripe/email 等外部副作用也不能可靠回滚；仍存在旧 session 有效窗口。

### C. 持久化 revocation generation（后续）

在 user/session 中持久化版本并在每次认证时比较，可把 credential 与 generation 放进同一 DB transaction，并解决跨 store 删除和并发登录竞态。但它需要 migration、serialize/deserialize/auth middleware、SSO/JWT 和 rolling deployment 兼容设计，不属于本批最小修复。

## 组件设计

### 1. Session store 注册

`SessionPersistance.ts` 继续拥有运行时 store 引用，并新增单例 MemoryStore 初始化路径。Passport middleware 的选择顺序保持现有产品语义：

1. `MODE=queue` 且不要求 restart expiry：RedisStore。
2. 非 queue 且支持的持久化 DB：对应 DB store。
3. 其余当前会隐式 fallback 的情况：显式创建 MemoryStore，并把同一实例传给 express-session 与 helper。

这只是让既有 fallback 可观察、可撤销；不把 MemoryStore 宣称为 production-ready。express-session 现有生产警告继续保留。

### 2. Store-specific revocation

Public wrapper 只负责选择当前 store、统一错误和稳定返回；具体删除逻辑保持隔离：

-   Redis：继续使用 `SCAN + MGET`，只收集匹配 `passport.user.id` 的 keys，按 1000 条分批 `DEL`。每次 `pipeline.exec()` 必须返回结果数组，且所有 tuple 的 error 均为空；key 已过期导致 `DEL=0` 不是错误。
-   PostgreSQL/SQLite/MySQL：保留 backend-specific set-based DELETE 和现有 payload column/JSON 表达式，不抽象为错误的统一 `LoginSession` column 模型。
-   MemoryStore：通过 `all()` 取得 `{ sid: session }`，仅对匹配 user id 的 sid 调用 `destroy()`；任何 callback error 均失败。
-   Missing/unsupported store：public wrapper 在 middleware 完成前被调用，或已注册 DB store 与当前 `DATABASE_TYPE` 不再匹配支持集合时，不得 warning 后继续，直接失败。正常 initializer 返回空 store 的现有 fallback 仍走上面的显式 MemoryStore。

无法解析、已过期或没有 `passport.user.id` 的 payload 安全跳过。锁定版 connect-redis 对 parse error 不会建立 authenticated session；若让任一坏 key 阻断所有用户改密，会制造跨用户 DoS。

### 3. 统一错误合同

新增 session-revocation 专用 typed error，HTTP status 固定为 500，客户端 message 固定为 `Failed to revoke active sessions`。原始 cause 保留在内部 error 对象，日志只记录稳定事件名、error name/code 和 store kind。

禁止在 error、日志或测试快照中输出：

-   user ID、email 或 credential；
-   session ID、Redis key、session payload；
-   token、cookie、Redis URL 或数据库连接信息。

Public wrapper 成功时只 resolve；失败时只抛 typed error，不返回“部分删除成功”状态，也不吞掉 cause。

## 敏感状态数据流

### Authenticated password change

```text
load current user
  -> validate actor/name/old password/new password/confirmation
  -> compute credential hash and safe patch
  -> determine passwordChanged
  -> if passwordChanged: revoke all sessions
       -> failure: typed 500; no user transaction started
  -> start user transaction
  -> save credential/token patch
  -> commit
  -> return sanitized user
```

### Reset password

```text
validate reset token and expiry
  -> validate/hash new password
  -> prepare credential + cleared token state
  -> revoke all sessions
       -> failure: typed 500; no user transaction started
  -> start user transaction
  -> save credential/token state
  -> commit
  -> return success
```

撤销发生在 transaction 之前，避免扫描大量 session 时持有 user transaction。当前请求对应的 session 也会被删除；当前响应仍可完成，但下一次受保护请求必须重新认证。

## 失败状态矩阵

| 阶段                            | 可见结果     | credential/token          | sessions           | 允许结论                          |
| ------------------------------- | ------------ | ------------------------- | ------------------ | --------------------------------- |
| 输入/token/旧密码校验失败       | 4xx          | 不变                      | 不变               | 没有安全事件发生                  |
| 撤销在任何删除前失败            | typed 500    | 不变                      | 不变               | fail-closed，无敏感写入           |
| 撤销部分成功后失败              | typed 500    | 不变                      | 部分或全部已撤销   | fail-closed，可安全重试；不称原子 |
| 撤销成功，user save/commit 失败 | 500          | 不变/transaction rollback | 已撤销             | 用户被额外登出，安全状态可重试    |
| 撤销与 commit 均成功            | 现有成功合同 | 已更新                    | 旧 sessions 已撤销 | password change/reset 成功        |

并发旧密码登录可能在 Redis scan 与 credential commit 之间创建新 session。本批不声称消除该竞态；生产强保证必须等待方案 C。

## 测试设计

### 预期 RED：Session helper

-   no-store 当前 resolve，期望 typed reject。
-   unsupported DB type 当前 resolve，期望 typed reject。
-   Redis pipeline 返回单条 error tuple 时，当前 resolve，期望 typed reject 并保留 cause。
-   Redis 多批删除中后续 batch 失败时，期望 reject，不把部分删除描述为成功。
-   显式 MemoryStore 中只删除目标 user sessions，保留其他 user；`all()`/`destroy()` error 必须 reject。

### 预期 RED：Service ordering

-   `updateUser` 的 revocation reject 时，不调用 `startTransaction/save/commit`。
-   `resetPassword` 的 revocation reject 时，不调用 `startTransaction/save/commit`，token/credential 不持久化。
-   success path 中 revocation invocation order 早于 `startTransaction/save/commit`。
-   save/commit failure 时 revocation 已完成且只调用一次；现有 query-runner 规则仍负责 rollback/release。

### 既有行为回归合同

-   PostgreSQL/SQLite/MySQL query builder 使用各自既有 WHERE/parameter，并传播 execute failure。
-   null、坏 JSON、无 passport user payload 安全跳过，不阻断其他有效 session 删除。
-   Redis pipeline 全部 tuple 成功时 resolve；`DEL=0` 仍视为成功。
-   name-only profile update 不触发全 session 撤销。

### GREEN 与回归

-   先让上述 focused tests 在旧实现稳定 RED，再做最小实现直至 GREEN。
-   运行新增 focused suites、full server Jest、server TypeScript、focused lint、workspace/server build。
-   运行 `git diff --check`、release/security/source gates、scoped secret scan 与 staged-diff review。
-   Mock/unit failure proof 的最高等级为 L2；不得写成 production DB/Redis failure proof。

## 预计文件边界

-   Modify: `packages/server/src/enterprise/middleware/passport/SessionPersistance.ts`
-   Modify: `packages/server/src/enterprise/middleware/passport/index.ts`
-   Modify: `packages/server/src/enterprise/services/user.service.ts`
-   Modify: `packages/server/src/enterprise/services/account.service.ts`
-   Create: `packages/server/src/enterprise/middleware/passport/SessionPersistance.test.ts`
-   Create: `packages/server/src/enterprise/services/user.service.test.ts`
-   Create: `packages/server/src/enterprise/services/account.service.test.ts`
-   Create: `docs/superpowers/specs/2026-07-16-flowise-session-revocation-failure-propagation-design.md`
-   Later update only after verified facts: `.kiro/plan/*`, current audit/runbook/AGENTS/README

不修改 `LoginSession` entity、migrations、package manifests、lockfile、public routes、UI 或 Provider nodes。

## 发布与生产门禁

本 design approval 只授权 spec 和后续 local implementation planning，不自动授权 build candidate、deploy 或 production failure injection。

完成 L2 后再独立判断：

1. scoped diff 与 full local gates 是否足以形成 immutable candidate；
2. 是否需要保持 production exact `61f248f...` 不变；
3. 若部署，是否沿用 Flowise-only cutover、exact image/archive/reload、rollback target、synthetic identity、双 reaper 和 fresh L3/L4 acceptance；
4. production acceptance 只测试 success path，不人为破坏 live DB/Redis。Failure propagation 的 production 结论最多来自自然故障证据，不能主动注入。

## 回滚

本批没有 migration 或数据转换。若 implementation/candidate 回归，源码回滚仅恢复 scoped implementation commit；若未来获批部署，运行态回滚恢复部署前 exact Flowise image/config，并只 recreate Flowise，不重启共享 PostgreSQL/Nginx。

回滚不会恢复已被安全事件撤销的 browser sessions；用户重新登录是预期行为。

## 验收与禁止外推

E0-E 可完成的精确结论：

-   `session_revocation_failure_propagation=L2_verified`；
-   `http_password_mutation_revoke_before_commit=L2_verified`；
-   `production_success_path=previous_E0-D_evidence_only`；
-   `production_failure_injection=false`。

禁止外推：

-   所有 password/email/CLI/SSO/JWT 入口均已覆盖；
-   session revocation 跨 Redis/DB/并发登录强原子；
-   production Redis failure path 已验证；
-   已构建、部署或完成二次生产浏览器验收；
-   `business_restore_proven=true`。

## 停止条件

-   RED 无法稳定复现 silent-success 或 ordering failure 时，停止实现并重新定位。
-   同一路径第三次验证仍未解决时，停止叠加 patch，转入 auth/session 架构审查。
-   任何现有 source/test path 出现不属于本批的 pre-existing diff 时，不覆盖、不格式化，先重新划定 ownership。
-   任何测试需要真实 Provider、SMTP、production secret、live DB failure injection 或 migration 时立即停止。
