# Flowise deferred RED contracts

日期：2026-08-10

状态：`wave_1b_local_csp_contract_implemented_external_observation_deferred`

证据等级：L1/L2 设计合同；不构成发布或生产证据

## 1. 目的与边界

本文件冻结 OpenCode 草案中仍有价值、但当前实现不应直接前移的验收合同。它不接入 CI，
不复制来源工作树中的 CSP analyzer、release staleness、Playwright、observability 或 regex i18n
实现，也不授权 push、Docker、registry、Provider、SMTP、生产写入或恢复操作。

每个后续实现必须先提交失败测试或失败 fixture，证明合同不是 vacuous pass；然后才允许最小实现。
“命令成功”“没有输入”“步骤 SKIPPED”均不能自动转成绿色结论。

## 2. 当前 main 的事实基线

| 领域    | 当前已有能力                                                                                                   | 本轮不复制的原因                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| CSP     | 结构化 `compat -> no-eval -> strict-script -> strict`、report-only header、同源 receiver、16 KiB/限流/脱敏测试 | OpenCode analyzer 在空输入时可通过，且未绑定观察窗口、receiver health 或页面覆盖率   |
| release | canonical manifest、deployment bundle、prepare/cutover/rollback immutable receipt 与大量 fail-closed validator | OpenCode staleness 草案依赖临时目录/可选输入，不能证明当前发布或部署身份             |
| browser | 隔离 authenticated Cypress runner、真实 CRUD/模块壳层测试、网络与清理合同                                      | OpenCode Playwright 草案缺 AUT 生命周期、强断言和 CI 绑定，并与 reporter/config 冲突 |
| i18n    | built metadata fingerprint、source hash、catalog/coverage/unknown/collision validator                          | 固定 `400` 条 regex 上限可被等量替换绕过，也重复当前 metadata 门禁                   |
| metrics | Prometheus 与 OpenTelemetry provider、HTTP counter/histogram、MCP 早期观测                                     | 现有配置尚未形成生产 scrape/鉴权、revision、隐私与告警闭环                           |

## 3. RED-CSP：CSP 观察与晋级合同

### 3.1 必填输入

-   `candidate_revision`：40 位提交 SHA，必须与待观察构建的 OCI revision 相等。
-   `window_started_at` / `window_ended_at`：UTC、单调、非空，窗口长度由调用方显式给出。
-   `source`：只接受持久化、不可变的日志/事件导出文件；不得默认扫描空目录。
-   `receiver_health`：窗口内 receiver 可达、有效 report、无效/超限/限流计数及日志时间边界。
-   `coverage`：公开页、认证页和 lazy workflow 的已执行清单；未执行项必须列入缺口。
-   `enforcement_mode` / `report_only_mode`：必须满足 report-only 严格于 enforcement。

### 3.2 fail-closed 条件

-   任一必填输入缺失、文件为空、SHA/窗口不匹配、receiver 未健康、coverage 未达标，退出非零。
-   未知 report shape 只输出固定分类和计数，不回显 URL query、body、header、token 或原始 sample。
-   0 violation 只有在 receiver health 与 coverage 同时有效时才是事实；否则状态为 `insufficient_evidence`。
-   report-only observation 不自动修改 enforcement 配置；晋级必须是独立授权和独立候选。

### 3.3 GREEN 输出

持久化 receipt 至候选 evidence 目录，至少绑定 schema、candidate SHA、窗口、模式、source digest、
receiver 计数、页面/流程覆盖率、按 directive/disposition 的低基数汇总和 `provider_call=false`。

## 4. RED-STALE：发布与部署新鲜度合同

### 4.1 唯一事实源

-   release 侧读取 canonical manifest/deployment bundle 的已验证持久化路径与 digest。
-   deployment 侧只读取 `/opt/flowise/deployments/<run_id>/` 下通过既有 exact-schema validator
    验证的 immutable prepare/cutover/rollback receipt；不得信任 `/tmp/releases`、自由文本或文件名时间。
-   current main/candidate identity 来自调用参数、Git exact SHA 与 manifest/OCI revision 的相等关系。

### 4.2 状态机与失败语义

```
source_main -> candidate_manifest -> prepare_receipt -> cutover_receipt -> observed_runtime
```

-   任一节点缺失、不可读、未知 key、digest 不匹配或 SHA 关系断裂，退出非零并标记
    `insufficient_evidence` 或 `identity_mismatch`，不得输出 fresh。
-   age 只能由 receipt 中已验证 UTC timestamp 计算；未来时间、非 UTC、负数、跨时钟异常失败。
-   rollback receipt 是显式终态，不得被误算成 candidate active。
-   backup/disk/health 不能用 `SKIPPED` 代替观测值；无法采集时该维度必须失败或明确阻断。
-   monitor 只读；不得创建、改写或补造 release/deployment receipt。

### 4.3 GREEN 输出

输出低敏摘要：schema、main/candidate/deployed SHA、run ID、receipt digest、阶段、age 秒数、
runtime revision、backup age/校验状态、disk 指标来源和逐项 evidence grade；不输出 env value。

## 5. RED-OBS：可观测性合同

### 5.1 指标正确性

-   PromQL 使用真实 histogram series `http_request_duration_ms_bucket`，并以 `rate(...[window])`
    聚合；禁止查询不存在的 `http_request_duration_bucket`。
-   counter/histogram 的 route label 必须模板化或低基数；不得记录 flow ID、workspace ID、
    request ID、原始 path/query、email、token 或 prompt。
-   Prometheus 与 OpenTelemetry 对 method/route/status/duration 的语义需由 provider 对照测试约束。
-   `BUILD_REVISION` 必须进入 runtime resource/`flowise_build_info` 类指标并与 OCI revision 相等；
    package version 不能替代提交身份。

### 5.2 暴露与鉴权

-   `/api/v1/metrics` 当前位于通用鉴权之后；后续实现必须先写路由顺序和 401/200 负正测试。
-   生产方案只能二选一并形成 ADR：私有 listener/sidecar scrape，或受保护 endpoint + 专用最小凭据。
-   不允许为了 scrape 把 metrics 加入公开 whitelist，也不允许在示例配置中提交凭据。
-   OTLP endpoint、TLS、重试/队列上限、shutdown flush 和失败策略需有离线 mock 测试；不得调用真实 collector。

### 5.3 最小告警与回执

首批只允许低基数 SLO：5xx 比率、p95 latency、进程 restart、磁盘余量、CSP receiver health 与
release staleness。每条告警记录 query、窗口、阈值、数据源、runbook 链接和无数据语义；
`no data` 默认不是 healthy。

## 6. RED-BROWSER：公开路由互补合同

-   复用 main 的 Cypress 体系；仅当 authenticated runner 无法表达公开路由时，才建立独立 public runner。
-   runner 自行启动并验证 exact AUT，要求 loopback base URL、随机 run ID、独立 artifact 目录、
    超时和双重 cleanup；不得依赖开发者已启动的任意服务。
-   至少覆盖 `/signin`、`/register`、`/forgot-password`、`/api/v1/ping`、auth resolve GET/POST，
    并断言状态码、关键 DOM、跳转、移动端无横向溢出、console/page error 和异常网络请求。
-   浏览器版本、Node 24、candidate SHA、base URL、spec/test 数、失败 artifact 与 cleanup receipt 必须绑定。
-   UI 仅“页面能打开”或弱文本存在断言不够；每个 public contract 至少有一个会在路由/响应漂移时失败的断言。
-   Playwright 仍可用于 Chromium sandbox 的既有脚本，但不能与产品 E2E 的配置/reporter 共享并冒充产品门禁。

## 7. RED-I18N：UI 静态文案债务合同

-   保留现有 built metadata validator 作为节点/凭据 metadata 的 canonical 门禁，不另加重复 regex 总量。
-   若要治理 UI JSX/TSX 硬编码文案，先生成 checked-in、path+line-independent 的归一化 baseline：
    key 使用语义摘要和模块，不使用容易漂移的行号。
-   新增债务、未知分类、危险机器字段被翻译或 baseline digest 漂移必须失败；删除债务允许通过并更新 receipt。
-   等量替换、拆字符串、模板字面量、aria/placeholder/toast/dialog 等入口必须有 mutation fixture，证明不能绕过。
-   baseline 更新需要可审查 diff 和原因标签；固定 `400` ceiling、`|| true`、缺文件自动创建均禁止。

## 8. 后续实施顺序与门禁

1. Wave 1A：release staleness + observability schema/fixture，只做本地 RED/GREEN 与文档，不接生产。
2. Wave 1B：CSP analyzer receipt 与 receiver/coverage fixtures；保持 enforcement 不变。
3. Wave 1C：public browser gap analysis；优先扩展 Cypress，仅在确有缺口时新增独立 runner。
4. Wave 1D：UI 文案 baseline ratchet；不得改写现有 metadata canonical contract。
5. Wave 2：经 Owner 单独批准后再接远端 CI、只读生产 monitor 或观测系统；每类外部副作用单独授权。

完成 D0 只表示这些合同已冻结并完成分流，不表示任何 deferred implementation 已交付。

## 9. Wave 1A 本地实现回执（2026-08-10）

### 9.1 已交付

-   `scripts/sha256-stream.sh`：发布器 SHA-256 stdin digest 在 Linux 优先使用 `sha256sum`，在 macOS
    严格回退 `shasum -a 256`；工具不存在、执行失败或输出畸形均 fail-closed。
-   `scripts/contracts/release-staleness.*.schema.json`：冻结 staleness 输入/低敏回执 exact schema，
    并以纯内存评估器约束 immutable receipt、SHA 身份、UTC age、rollback 与 no-data。
-   `scripts/contracts/observability.*.schema.json`：冻结 observability 输入/低敏回执 exact schema，
    并约束真实 histogram series、受保护或私有 scrape、revision、低基数/privacy、SLO/no-data。
-   9 份 checked-in 正负 fixture 与 14 条本地合同测试；所有 fixture 均是合成数据，不是生产观测。

### 9.2 验证证据

-   local commits：`12be39b8`（SHA-256 portability）、`8ea347fc`（monitor contracts）。
-   Node 24 纯本地 release + monitor contracts：`95/95`，其中原 release contracts `81/81`、
    新 monitor contracts `14/14`。
-   Bash syntax、Prettier、ESLint、diff/index 与强秘密模式扫描通过；CodeGraph 已同步代码变更。

### 9.3 仍未交付

本回执不代表生产 monitor、Prometheus/OTLP collector、scrape 凭据、告警规则部署、远端 CI、
Docker/registry、真实 candidate、生产部署/回滚或 restore 验证已经执行。上述每类外部动作仍需
独立门禁与 Owner 授权。该本地缺口已由下节 Wave 1B 回执关闭；外部 observation 仍未执行。

## 10. Wave 1B CSP 本地观察合同回执（2026-08-10）

### 10.1 已交付

-   `scripts/contracts/csp-observation.input.schema.json` 与 `csp-observation.receipt.schema.json`：
    冻结 candidate/OCI SHA、UTC window、严格 mode ladder、不可变非临时 source、receiver health/count、
    `wave1b_minimum_v1` coverage 和低基数 directive/disposition summary。
-   `scripts/contracts/csp-observation.mjs`：只消费内存中的已脱敏观察输入；空 source、receiver 不可达、
    coverage 缺口、mode/SHA/window/clock/count 漂移、重复桶和“零违规但有丢弃事件”均 fail-closed。
-   clean/violations 两个正例和 13 个对抗性负例。输出不包含 source path、URL、query、header、body、
    token 或 sample；固定 `evidenceGrade=L2`、`promotionDecision=not_authorized`、
    `providerCall=false`、`enforcementChanged=false`。

### 10.2 验证证据

-   local commit：`f6c26ec7`（`test(security): freeze local CSP observation contract`）。
-   CSP contract=`16/16`；既有 server XSS/CSP/report receiver/auth policy=`4/4 suites, 102/102 tests`。
-   纯 Node release + Wave 1A monitor + Wave 1B CSP=`111/111`；Prettier、ESLint、diff、secret-safe、
    fixture symlink 与 package/lockfile no-diff 门禁通过；CodeGraph 已增量同步 3 个代码文件、21 nodes。

### 10.3 仍未交付

本回执只有 L2 fixture 证据，不证明 report-only 已启用、生产 receiver healthy、真实 public/auth/lazy
coverage 完成、真实 CSP violation 为零或 enforcement 可以晋级。本轮没有启动 AUT/浏览器、读取真实日志、
修改 CSP runtime/env、写 candidate evidence、运行 Docker/远端 CI 或访问生产。下一推荐门禁为 Wave 1C
public browser gap analysis：先对照现有 authenticated Cypress 能力，只在确有公开路由缺口时扩展 local runner。
