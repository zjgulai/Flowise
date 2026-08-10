# Flowise main convergence ledger

日期：2026-08-10

目标分支：`codex/flowise-main-convergence-20260810`

基线：`origin/main=96f6ae464f7f4757883a5ba6bec26ca951b4da4d`
来源工作树：`/Users/pray/project/FlowAgentic/flowise`（只读证据源）

## 1. 收敛规则

-   不整体 merge 或 cherry-pick 旧发布基础分支。
-   旧 SHA 的 candidate、production evidence、计划 checkbox 和 Dockerfile 不能成为 main 的 release 证据。
-   每项只允许 `reimplement`、`port`、`archive-reference`、`drop`、`defer-redesign`、`external-blocked` 六种结论。
-   代码前移必须基于 main 当前实现重新验证；dirty source 不能直接复制后宣称完成。
-   本门禁只形成 local commits；push、merge、PR、Docker、生产、Provider 和 restore 均关闭。

## 2. 分支事实

| 项目                 | 事实                                                       |
| -------------------- | ---------------------------------------------------------- |
| main 基线            | `96f6ae46...`，PR #14 已合并                               |
| 旧分支 HEAD          | `4d56ffd3...`                                              |
| 分叉                 | `main-only 51 / active-only 8`                             |
| 旧分支远端           | 同名远端仍为共同基点 `e11c4a5d...`                         |
| 新 worktree 初始状态 | clean，HEAD exact main                                     |
| 生产证据边界         | `45d25b20...` 仅为 2026-08-07 历史收据，不证明 main 已部署 |

## 3. Active-only commits 决策

| Commit     | 内容                                      | 决策                | 原因与目标产物                                                                               |
| ---------- | ----------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `b4916a7e` | 旧计划 current-state                      | `archive-reference` | 只提炼仍有效 blocker，不搬运旧 checkbox                                                      |
| `f0a866fa` | AboutDialog 去 GitHub 外联 + CSV 归档     | `reimplement`       | 两个 concern 必须拆分；AboutDialog 保留 main a11y/state 逻辑，CSV 由 compatibility test 约束 |
| `96aea260` | 旧计划标记 CSP 完成                       | `drop`              | CSP analyzer 已证实空输入 fail-open，完成状态不成立                                          |
| `ae907fcf` | 删除 active CSV 模板 + CSP 文档           | `reimplement`       | 只前移 CSV compatibility 结论；CSP 文档等待新 RED 合同                                       |
| `45d25b20` | 历史证据、归档、替代 Dockerfile、运维文档 | `archive-reference` | 不把旧候选、替代镜像和运行收据带入 main；仅在 ledger 引用历史边界                            |
| `ea2f02e5` | `45d25b20` clean candidate 收据           | `archive-reference` | exact SHA 不同，不能继承为 main candidate                                                    |
| `d6baecc5` | RBAC H3 设计                              | `port`              | 设计仍有效；前移时明确 L1/L4 分层和双 reaper 授权                                            |
| `4d56ffd3` | `45d25b20` 生产收据与 AGENTS 状态         | `archive-reference` | 仅保留历史身份，不覆盖 main/实时生产状态                                                     |

## 4. OpenCode dirty/untracked assets 决策

| 来源路径                                                           | 决策             | 本门禁产物/下一合同                                                                       |
| ------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| `.github/workflows/main.yml`                                       | `defer-redesign` | main 已有 built metadata validator；不复制固定 400 regex 阈值                             |
| `.github/workflows/production-readonly-monitor.yml`                | `defer-redesign` | staleness 无持久输入、backup/disk 为 SKIPPED；先定义 receipt/telemetry fail-closed 合同   |
| `.kiro/plan/{task_plan,progress,findings}.md`                      | `reimplement`    | 在 main 只写 current reconciliation，不复制旧分支全量增量                                 |
| `docs/audits/flowise-delivery-gap-audit-20260810.md`               | `reimplement`    | 本 ledger 吸收可执行结论；完整旧审计保留在来源工作树                                      |
| `docs/ops/flowise-ci-github-setup.md`                              | `defer-redesign` | live GitHub 已证明 basic protection/env 存在；文档需改为 partial-state                    |
| `docs/ops/flowise-observability-setup.md`                          | `defer-redesign` | 修正 PromQL、metrics 鉴权、runtime revision 与数据最小化后再交付                          |
| `packages/server/src/enterprise/rbac/rbac-negative-matrix.test.ts` | `port`           | 适配 main，作为 PermissionCheck L1；另保留真实 route/member L4 blocker                    |
| `packages/ui/test/playwright/*`、`playwright.config.ts`            | `drop`           | 弱断言、reporter 冲突、无 AUT/CI；main 已有 Cypress，后续只设计互补 public-route contract |
| `scripts/analyze-csp-violations.mjs`                               | `defer-redesign` | observation receipt、非空窗口、receiver health、coverage 必填；无输入 fail-closed         |
| `scripts/check-release-staleness.mjs`                              | `defer-redesign` | 以持久 artifact/deployment receipt 为事实源；无输入 fail-closed                           |
| `scripts/verify-i18n-coverage.py`                                  | `drop`           | 不复制 regex 400 debt ceiling；如需 UI 文案门禁，采用 checked-in baseline ratchet         |
| `scripts/__pycache__/*`                                            | `drop`           | 生成物不前移；main 增加通用 Python cache ignore                                           |

## 5. 本门禁原子组

### Group 1：mainline state reconciliation

-   本 ledger。
-   `.kiro/plan/task_plan.md`、`progress.md`、`findings.md` 的 current D0 状态。
-   只包含事实与决策，不声称 release/production ready。

### Group 2：marketplace/UI/generated-cache compatibility

-   在 main AboutDialog 上仅移除 runtime GitHub API。
-   CSV Agent 从 active marketplace 退出，并增强测试避免 vacuous pass。
-   `.gitignore` 增加 Python cache 规则。
-   focused UI/server tests、Prettier、diff check。
-   状态：完成。提交 `c512ec5f`（AboutDialog）、`71b3d047`（CSV archive/test）、`5553d66f`（Python cache ignore）。

### Group 3：RBAC L1 contract

-   前移并适配 22-case PermissionCheck 测试。
-   文档明确真实 member、route、cross-workspace 和 double reaper 仍未执行。
-   focused server Jest、lint/format/diff check。
-   状态：完成。focused Jest `22/22`，提交 `74dea80b6f`；真实 route/member L4 仍阻断。

### Group 4：deferred RED contracts

-   为 CSP、release staleness、observability、public browser/i18n 分别冻结缺失输入和验收标准。
-   不复制已知有缺陷的实现，不接入 CI。
-   状态：合同已冻结到 `docs/superpowers/plans/2026-08-10-flowise-deferred-red-contracts.md`；实现继续 defer。

## 6. D0 完成标准

-   所有 active-only commits 与 OpenCode assets 均有唯一决策。
-   新 worktree 只含上述原子组的 local commits，index empty。
-   focused tests、format、diff、secret-safe 检查有 fresh 输出。
-   CodeGraph 绑定新 worktree，原 dirty worktree 状态未被改变。
-   剩余项明确进入 Wave 1/2 或外部授权，不把 local candidate 提升为 release/production 证明。

## 7. D0 执行回执

| 维度              | 终态                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local commits     | AboutDialog `c512ec5f`；CSV `71b3d047`；Python ignore `5553d66f`；RBAC `74dea80b6f`；本 ledger/计划/deferred contracts 由 `docs(plan): close main convergence wave zero` 收口 |
| focused tests     | UI `5/5`；marketplace `3/3`；RBAC `22/22`                                                                                                                                     |
| metadata          | fingerprint `2/2`；311 nodes；91 dynamic methods；unknown 0                                                                                                                   |
| release contracts | Node `77/77`，使用一次性 macOS SHA-256 compatibility wrapper；wrapper/临时目录已清理，正式 portability 修复未前移                                                             |
| security          | static `340` PASS；Docker Compose render 依 Owner no-touch 边界未执行，故 full gate 非 GREEN                                                                                  |
| CodeGraph         | current-worktree `init` + `sync`：2,205 files、30,459 nodes、67,156 edges；status up to date                                                                                  |
| source checkout   | HEAD `4d56ffd3...` 不变，index empty，ambient dirty/untracked path set 保留                                                                                                   |
| side effects      | `push=false`、`merge=false`、`pr=false`、`docker=false`、`registry=false`、`provider_call=false`、`smtp_send=false`、`production_write=false`、`restore=false`                |

下一推荐门禁是 Wave 1A local-only：release staleness/observability schema fixtures 与 `sha256sum`
portability 最小修复；CSP enforcement、remote CI、production monitor、RBAC L4 和所有生产动作继续分离授权。
