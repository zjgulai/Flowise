---
title: Flowise 审计整改与生产验收执行计划
date: 2026-07-10
last_updated: 2026-08-03
status: in_progress
evidence_model: L0-L4
---

# 目标

把 2026-07-10 对抗式审计中的问题从“报告条目”推进为可追溯的修复、部署和产品验收证据，同时保持可回滚，不调用外部模型供应商，不读取或输出密钥值。

# 边界与完成标准

-   `provider_call=false`：Deepseek、Kimi、OpenAI 等只做加载、配置 UI 和 mock contract test。
-   `secrets_read=false`：只允许检查环境变量 key 是否存在，不读取或打印 value。
-   生产变更只在本地 L2 构建和回滚检查通过后执行，并保留备份、镜像 ID/digest、部署时间与验收结果。
-   本地测试、生产只读检查、已授权生产写入分别标记为 L2、L3、L4，不互相替代。
-   不覆盖或整理当前工作区中与本轮无关的大量用户改动。
-   2026-07-10 用户已明确授权下一批生产执行路线：本地构建并验收 `linux/amd64` Node 24 镜像、校验并上传制品、在远端无构建切换、执行生产验收，失败立即回滚。

# 状态图例

-   `[x]` 已完成且有证据。
-   `[~]` 正在执行。
-   `[ ]` 待执行。
-   `[!]` 受外部条件或授权边界阻塞。

# 分批执行计划

## Batch 0：基线重建与当前产品复核（已完成）

-   [x] 读取仓库 `AGENTS.md`、生产审计、既有整改计划和生产执行记录。
-   [x] 确认实际 git root、分支及脏工作区边界。
-   [x] 重新采集线上未登录产品流、API、端口、容器和日志的 L3 证据。
-   [x] 建立“已上线 / 仅缓解 / 本地已修 / 未开始 / 无法验收”状态矩阵。
-   [x] 输出当前产品形态与剩余工作的统一 source of truth 到 `.kiro/plan/findings.md`。

## Batch 1：可复现 Node 24 镜像（最高优先级）

-   [x] 复核 `Dockerfile` 各阶段依赖、构建上下文、runtime 工具链与 image size 来源。
-   [x] 运行本地静态检查、server/UI unit test、typecheck 和 UI build。
-   [x] 构建 `linux/amd64` Node 24 production image，依赖安装保持 strict frozen lockfile。
-   [x] 在镜像内验证 Node 24、无 AppleDouble、health path 和 server entrypoint；runtime 改为直接 Node CLI，不依赖 pnpm。
-   [x] 记录 image ID、artifact SHA256、git SHA、dirty-tree 边界和构建日志摘要。
-   [x] 对每个构建失败按首个确定根因修复并增加静态门禁；最终 clean builder 4/4 workspace 通过。

## Batch 2：生产镜像交付与 P0/P1 上线

-   [x] 流式上传已验证镜像并完成双端 SHA256 校验。
-   [x] 备份远端 compose、env 文件、脱敏 image/container metadata 与防火墙规则，保留旧镜像 rollback tag。
-   [x] 用 `--env-file .env.production` 验证 Compose，只检查 key/结构。
-   [x] 切换到 Node 24 镜像；生产端口绑定私有反向代理 bridge gateway `172.20.0.1:3000`，不再发布到公网接口。
-   [x] 重新应用已审阅的非 secret 安全配置 key，并保留 provider key 空白状态。
-   [x] 第一次 HTTPS 502 后立即回滚；定位容器化 Nginx upstream 拓扑后，第二次切换通过联合门禁。

## Batch 3：未登录产品/API 生产验收

-   [x] HTTPS `/api/v1/ping` 返回 `pong`，HTTP 域名跳转 HTTPS。
-   [x] 公网 `:3000` 不可达，容器仅绑定 `172.20.0.1:3000` 私有 bridge gateway。
-   [x] `GET /api/v1/auth/resolve` 返回受控 405，body 不暴露内部字段。
-   [x] `POST /api/v1/auth/resolve` 保持 `/signin` 合约。
-   [x] `/register` 在已初始化 open source 实例自动跳转 `/signin`，不显示死提交表单。
-   [x] `/signin`、`/forgot-password`、`/register` 已完成桌面/移动浏览器证据；未提交表单。
-   [x] `390px` 认证页无横向溢出，标题、字段、显示密码和忘记密码均在视口内。
-   [x] `/signin` 初始化不再出现 `TypeError: e is not a function`。
-   [x] 浏览器 console 无 Google Fonts/Rewardful CSP error/warning。
-   [x] 非法 Origin prediction CORS 预检不返回 ACAO，也未产生错误日志。
-   [x] 启动日志无 Node engine、AppleDouble、auth-secret 和 TypeError 四类错误。

## Batch 4：认证后的核心产品 E2E（不调用 provider）

-   [!] 明确可用的测试账号/隔离 workspace 与数据清理策略，不在日志中暴露凭证；当前没有可用测试身份与安全的凭证交付路径。
-   [ ] 验证登录、session 持久化、刷新、退出与失效态。
-   [ ] 验证 SMTP 未配置/已配置两种忘记密码反馈；真实邮件发送需另行授权并使用测试收件箱。
-   [ ] 创建最小 chatflow，添加本地/无供应商节点，保存、重开、复制、删除。
-   [ ] 验证 Agentflow 编辑、执行历史空态/详情入口，不发起外部模型调用。
-   [ ] 验证 document store 小文件上传、预览、删除与越权边界。
-   [ ] 验证 API key 创建/撤销、变量、凭证列表的敏感信息遮罩。
-   [ ] 验证 open source 下 workspace/user/role 菜单与后端授权策略一致。
-   [ ] 对每个写入型 smoke 记录测试数据 ID，并在验收后清理。

## Batch 5：Deepseek/Kimi 定制节点质量门禁

-   [x] 对 credential schema、load methods、base URL、streaming/tool binding 建立 unit test。
-   [x] 使用 mock transport 验证请求映射、超时、错误脱敏和取消行为。
-   [x] UI 以节点元数据、字段配置和 credential selector 合约完成 L2 验收；认证截图继续等待 Batch 4 测试身份。
-   [x] 增加 provider allowlist 与 redirect-aware secure fetch；未批准前不做真实 provider call。
-   [x] 补充定制节点维护文档和 upstream merge 冲突点。
-   [x] Task 4 commit `b73a3c8` 已通过 Provider tests `225/225`、build、compiled-load smoke 与独立复审；未部署，`provider_call=false`。

## Batch 6：安全头、CSP 与入口职责治理

-   [x] 形成 header contract：Nginx 负责 HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy，app 负责 CSP。
-   [x] 在 Flowise 专属 proxy location 隐藏上游四个重复头，保持 app 直连部署仍有安全头兜底。
-   [x] 标准化 `IFRAME_ORIGINS` 并对非法 CSP keyword fail fast；Task 5 commit `1372561` 已通过 server `127/127`、UI `65/65`、static security `52/52` 与独立复审，生产尚未部署。
-   [~] 分阶段移除 `unsafe-eval` / `unsafe-inline`，先建立 report-only 观测能力再收紧；July 12 L3 仍为 CSP enforcement only 且包含 `unsafe-eval`，生产观测与策略提升未授权。
-   [x] 增加只读 HTTPS/header/auth/CORS contract smoke，覆盖恶意 Origin 与公开 prediction。

## Batch 7：技术债、工程债与文档债收敛

-   [ ] 将硬编码中文文案按模块盘点，决定 i18n 适配层或明确 hard-fork 策略。
-   [ ] 建立 upstream sync checklist：engine、Docker、auth、CORS、自定义 nodes、i18n。
-   [!] Release manifest source/config contract 已由 Task 6 commit `699b59b` 完成；实际 image/archive manifest 因 registry metadata `EOF` 在 Dockerfile evaluation 前阻塞，五项 Docker/runtime verification 均为 false。
-   [ ] 归档或标注 superseded 的根目录报告，只保留一个当前状态入口。
-   [ ] 补齐 backup/restore 演练、故障回滚、日志保留和容量监控 runbook。
-   [ ] 量化主 bundle 与镜像体积，分离未登录入口 bundle 和 runtime 编译工具链。
-   [ ] 从 runtime image 移除 `make`、`g++`、`build-base`、`*-dev` 和非必要 `git`，并用节点运行矩阵确认不会破坏需要原生工具的功能。
-   [ ] 处理 About dialog 对 GitHub latest release 的运行时请求：可关闭、缓存或改为自托管版本信息。

# 2026-07-10 Batch 5A 历史执行范围（当前 contract 以 Task 4 为准）

完整实施步骤：`docs/superpowers/plans/2026-07-10-flowise-provider-contract-hardening.md`。

## Gate P1：共享输入与 endpoint 安全

-   [x] 对照本地 LangChain/OpenAI SDK 源码与 Deepseek/Kimi 官方文档确认当前请求合同。
-   [x] 先写失败测试，覆盖 HTTPS、origin allowlist、URL 凭证/query/fragment、header injection、数值解析和 secure fetch 注入。
-   [x] 最小实现共享 provider helper，不新增依赖。

## Gate P2：Deepseek 节点

-   [x] 测试并修复 `apiKey` 字段、V4 默认模型、credentialId、thinking/reasoning、stop/numeric 参数和 Base Options。
-   [x] 用 mock transport 验证请求 URL/body/header、timeout 与 401 脱敏；禁止真实请求。

## Gate P3：Kimi 节点

-   [x] 把 credential 从 optional 收紧为 required，防止环境中其它 OpenAI key 误用到 Kimi endpoint。
-   [x] 当时测试并实现 K2.6 默认、thinking、streaming、tools、取消、401 脱敏和 K2.7/K2.6/K2.5 固定参数约束；Task 4 后续改为 fail-closed，不再暴露 thinking controls 或 K2.7。

## Gate P4：模型目录与 UI 元数据

-   [x] 历史目录曾加入 Deepseek V4 与 Kimi K2.7/K2.6/K2.5；Task 4 当前目录排除 thinking-only/K2.7，保留 K2.5/K2.6 与 Moonshot V1。
-   [x] 节点 metadata/load-method/credential schema 测试替代受账号边界阻塞的认证 UI 截图。

## Gate P5：L2 验收与文档

-   [x] 历史 dirty-tree evidence 为 components 24 suites/943 tests；Task 4 当前 commit evidence 为 Provider `225/225`、TypeScript、focused lint、components build、static security `52/52` 和 compiled-load smoke。
-   [x] 编译后加载两个节点但不 invoke，记录 `provider_call=false`、`secrets_read=false`、`production_write=false`。
-   [x] 更新维护文档、审计 findings/progress 与后续 Batch 5B 边界。

## Batch 5B 后续边界

-   [!] 真实 DeepSeek/Kimi sandbox smoke 需要单独 owner 授权、测试账号、费用上限与脱敏证据。
-   [!] 认证后的节点选择器、credential selector 和保存/重开截图等待 Batch 4 专用测试身份。
-   [ ] 在重新暴露任何 thinking-only/K2.7 能力前，先验证 `reasoning_content` 在工具调用、消息持久化与 UI 展示中的端到端完整性，并单独设计 `tool_choice` 约束。
-   [ ] 为模型成本建立币种、单位和 cache hit/miss schema 后再补 Kimi 新模型成本。

# 本轮执行范围：Batch 6A 安全头单一所有权

## Gate H1：对抗性基线与失败测试

-   [x] 分别抓取 app 直连与公网 HTTPS 原始响应头，确认重复来自 app 与 Nginx 双重写入。
-   [x] 把 HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 各出现一次写入只读生产 smoke。
-   [x] 修复前 smoke 稳定得到 10 passed、4 failed；四项失败均为重复头基数。

## Gate H2：最小修复与部署保护

-   [x] 仅修改 `flowise.lute-tlz-dddd.top` 的 Nginx `location /`，不改变共享代理的其他域名。
-   [x] 备份持久化 Nginx 配置并保存校验值；候选配置先通过容器内 `nginx -t -c`。
-   [x] 首次 reload 因单文件 bind mount inode 未更新而触发自动回滚；最终通过 Compose 只重建 `nginx` 服务应用配置，失败路径保留自动回滚。

## Gate H3：L4 验收

-   [x] 生产 edge smoke 14/14 通过；header/auth/CORS 合约全部满足。
-   [x] 从 Nginx 容器和公网分别验证 `/api/v1/ping`，upstream 与 HTTPS 均返回 `pong`。
-   [x] 浏览器复验 `/signin` 桌面和 390px，console 0 error/0 warning，移动端无横向溢出。
-   [x] Nginx/Flowise 新鲜日志目标错误计数为 0，两个容器 restart count 均为 0。

# 本轮执行范围：Batch 6B CSP 与 Iframe 配置治理

完整设计与实施步骤：

-   `docs/superpowers/specs/2026-07-10-flowise-csp-iframe-governance-design.md`
-   `docs/superpowers/plans/2026-07-10-flowise-csp-iframe-governance.md`

## Gate C1：Iframe fail-fast

-   [x] 以 RED 测试定义 exact-origin、keyword、分隔符、production HTTPS 与 wildcard 边界。
-   [x] 使用结构化 URL 解析、去重和通用错误实现 `IFRAME_ORIGINS` fail-fast。

## Gate C2：结构化 CSP 与 Report-Only

-   [x] 建立 `compat -> no-eval -> strict-script -> strict` 单调收紧模式。
-   [x] 默认 `compat` enforcement / `off` report-only；非法模式或非收紧候选启动失败。
-   [x] 增加同源、16 KiB、限流、脱敏的 CSP report receiver。

## Gate C3：UI 与配置集成

-   [x] 外置 UI inline bootstrap，不声明已解决构建产物中的 legacy dynamic `Function(...)`。
-   [x] 单点生成 CSP headers，新增模板/Compose 的非 secret 模式 key 与静态门禁。

## Gate C4：本地 L2 验收

-   [x] Server focused/full Jest、TypeScript、focused lint 通过。
-   [x] UI Jest/build、inline-script scan、dynamic-code scan 通过；构建产物中的 dynamic `Function(...)` 已记录为 enforcement blocker。
-   [x] 静态安全门禁、Compose render、diff check 与隔离本地 HTTP smoke 通过。
-   [x] 对抗性复审并同步 audit/findings/progress；保持 `production unchanged`。

# 2026-07-12 Stage 0 Release Foundation

-   [x] Task 1 source boundary：`92f8891`，review approved。
-   [x] Task 2 UI/auth：6 commits，162 unique paths，review approved。
-   [!] Task 3 runtime source 已审阅；Docker registry metadata/DNS 阻塞 runtime image verification。
-   [x] Task 4 Provider：`b73a3c8`，`225/225`，`provider_call=false`，未部署。
-   [x] Task 5 CSP/request：`1372561`，server `127/127`、UI `65/65`、static `52/52`，未部署。
-   [!] Task 6 provenance：`699b59b`，release `18/18`、static `95/95`、clean-clone frozen install 通过；没有 candidate image/archive/actual manifest。
-   [x] Task 7 current-state docs：July 12 L3 与本地 source/config 证据已同步，并通过 9-path 原子门禁与独立复审。
-   [x] Task 8 whole-branch verification/review：修复 commit `75f75f4`，clean-clone full gates 与三条独立复审通过；未 merge、push、PR、deploy 或调用 Provider。

Task 7 前本地快照：branch `codex/flowise-release-foundation-20260712`，base `bb773ffa710bd22639c4ba2643413a0ea2b679d3`，source HEAD `699b59b1c08413e0785a9732c2dfe4c020b4a331`，12 commits/212 paths，`tracked_changed_paths=2`、`untracked_paths_all=32`、`cached_paths=0`。

July 12 L3 确认生产仍运行 July 10 image `sha256:3c66e08b50562ab856328d669b611d000ccee6c9467f1560b7b8b4ba0b86fad9`；public 3000 refused、edge `14/14`、Node `v24.18.0`、restart `0`。Task 4/5/6 均未由 Stage 0 部署，`production unchanged`；`backup_state=exists_not_checksum_or_restore_verified`。

# 后续批次执行顺序

1. **Release artifact completion（本地）**：registry/build 可用后，从 clean commit 构建并 inspect `linux/amd64` candidate，生成并验证真实 archive manifest；当前不得把 source/config 证据冒充 image/runtime evidence。
2. **Production encryption-key migration（需单独授权）**：用受保护流程复用当前容器层 key，准备 immutable rollback，再允许 Flowise recreate；不得打印、轮换或臆造 key。
3. **Batch 7A 剩余项**：upstream sync checklist、历史文档归档、backup restore drill、日志和容量策略。
4. **Batch 5B（本地可执行项）**：先补 `reasoning_content` 持久化/UI 链路和统一成本 schema，再决定是否重新暴露 K2.7；真实 provider smoke 继续等待单独授权。
5. **Batch 4（条件阻塞）**：取得专用测试账号和隔离 workspace 后执行认证后 E2E；所有生产写入记录 ID 并清理。
6. **Batch 7B（性能与攻击面）**：runtime 工具链和镜像瘦身、未登录 bundle 拆分、About 外联治理；必须用节点运行矩阵防止瘦身破坏功能。

# 已完成的 Node 24 生产批次证据

## Gate A：本地源码与构建前门禁

-   [x] 刷新安全静态检查、`git diff --check`、server 定向 Jest、server TypeScript、UI Jest 与 UI production build。
-   [x] 核对 `Dockerfile`、Compose image/tag、目标平台、healthcheck、runtime entrypoint 与 `.dockerignore`。
-   [x] 记录本地 git SHA、脏工作区事实与本批次涉及文件；不把 dirty tree 描述成可复现 release commit。

## Gate B：离线 Node 24 镜像制品

-   [x] 构建 `linux/amd64` production image，依赖安装使用 frozen lockfile。
-   [x] 在镜像内验证 Node 24、server entrypoint、healthcheck 与无 `._*` 文件；runtime 不再要求 pnpm。
-   [x] 记录 image ID、manifest、架构、大小与构建时间。
-   [x] 用 `docker save | gzip` 流式上传并完成双端 SHA256 校验，未在本地重复落盘 tar。

## Gate C：生产切换前保护

-   [x] 刷新 HTTPS、auth GET/POST、direct port、容器健康、Node 版本和防火墙 L3 基线。
-   [x] 新建独立时间戳备份，保存 compose、env 副本、脱敏 metadata 与 firewall rules，不输出 env value。
-   [x] 上传并 `docker load` 镜像；校验目标 tag 与 Compose contract 一致。
-   [x] 部署前用 `--env-file .env.production` 运行 config 校验；只检查环境变量 key/结构。

## Gate D：生产无构建切换与自动回滚

-   [x] 使用已加载镜像执行 `up -d --no-deps --no-build flowise`，PostgreSQL 未重启。
-   [x] 第一次切换出现 HTTPS 502 后恢复旧 compose/env/image 并复验 `/ping`；第二次切换成功。
-   [x] 保留现有网络防护，同时把 compose 根因收敛为私有 bridge bind。

## Gate E：L4 生产验收

-   [x] 容器内 Node 为 24，日志无 engine warning、AppleDouble、auth-secret 初始化错误和 TypeError。
-   [x] HTTPS `/ping`、auth POST 合约通过；auth GET 返回 405。
-   [x] `docker inspect` 无公网 `0.0.0.0:3000`，外部 direct port 不可达，gateway/proxy upstream 可达。
-   [x] 浏览器验证 `/signin` 无初始化 TypeError、无 Google Fonts/Rewardful CSP 错误，桌面/390px 无裁切。
-   [x] `/register` 在已初始化 open-source 实例自动跳转 `/signin`。

## Gate F：状态同步与后续批次

-   [x] 更新生产部署计划、runbook、`.kiro/plan/findings.md` 与 `.kiro/plan/progress.md`，逐项标记 L2/L3/L4。
-   [!] Batch 4 无 provider 认证 E2E 等待专用测试账号、隔离 workspace 与安全凭证交付路径。
-   [x] 保持 Batch 5 真实 provider call 为禁用状态，直到新的明确授权。

# 2026-07-28/29 遗留 Bootstrap 恢复与新版本生产闭环

## Gate R0：事故冻结与恢复设计

-   [x] 保持现网旧容器只读稳定：Flowise `running/healthy`、restart `0`，内外网 `/ping` 均为 `pong`；未重放失败的 bootstrap、未执行通用 rollback。
-   [x] 为 run `20260728T171644Z-4914e862` 编写仅适用于该事故的 observed-state recovery amendment；固定 permit、prepare receipt、当前/基线容器、请求/观察 hash、镜像、seccomp、完整 runtime 与数据库迁移 authority。
-   [x] 实现 exact run topology、existing-only lock、双观察 CAS、不可覆盖 receipt、journal preimage CAS、落盘回读和静态终态 authority。

## Gate R1：本地实现与对抗性验证

-   [x] 完整绑定 Docker Config 17-key 与 HostConfig 66-key；仅对 SecurityOpt 做语义归一，`Healthcheck.StartInterval` 仅接受原生整数 `0`。
-   [x] 所有 opaque Compose hash 路径强制 exact image identity、image Config.Env 与 Compose environment overlay，并拒绝任意字段删除、替换或新增。
-   [x] 恢复观察以同一次 no-follow `live_file` bytes 贯穿 raw hash、canonical seccomp 与 runtime 校验，消除 pathname reopen TOCTOU。
-   [x] Node release tests `75/75`、Python unit/integration `137/137`、security `337/337`、Pyright `0`、py_compile、diff-check 全绿。
-   [x] 隔离真实 Docker boundary `8/8` 通过，随后独立确认 fixture container/volume/network/image 零残留。
-   [x] 独立安全复审 `APPROVE`，风险 `LOW`，Critical/High/Medium 均为 `0`。

## Gate R2：提交、CI 与自绑定恢复产物

-   [x] 冻结文档与计划状态，原子提交 recovery wrapper、测试和 spec；CI portability 与审查修复继续使用独立原子 commit。
-   [x] 关闭 exact-head Node CI 暴露的 Chatflow Cypress alias 竞态：保持真实 UI CRUD/reopen 链路，改用页面状态与 API 回读作确定性证据；两次独立新数据库的本地 Chrome 聚焦重跑均通过。
-   [x] 关闭第四笔 exact-head Node CI 暴露的首次 reopen 硬导航竞态：等待保存成功提示，通过流程列表内 SPA 导航完成 reopen/copy；最终内容双轮聚焦 Chrome `1/1`、四套件全量 Chrome `5/5`。
-   [x] 推送分支并创建 PR `zjgulai/Flowise#10`；第四笔 exact head 的 Docker CI 已全绿，Node CI 的唯一失败已形成第五笔最小 test-only 候选。
-   [x] 对第五笔候选完成本地 release/security/build/static 和独立复审；复审 `APPROVE`，唯一 LOW 已用精确初始 `/canvas` 访问合同关闭。
-   [x] 对 LOW 修复后的第五笔精确代码内容重跑 release/security/build/static，全部通过；独立复审确认所有 severity 均为 `0`。
-   [x] 第五笔候选已以 `7c650142f5cda0833834582e940a4ea18dbec459` 原子提交；exact-head Node CI `30400942705` 与 Docker CI `30400942552` 全绿，PR `#10` 已合并为 `b9070d7d6dea20696e1dc40df47510f0b7039d3c`。
-   [x] 合并后的 `main` 仅触发一次人工 Docker readiness run `30402079400`；build/readiness 全绿，下载制品已独立验证 source/config/bundle identity 并安装为生产候选，现网 runtime/config/database 未切换。
-   [!] `b9070d7d` 候选的 zero-write recovery snapshot 精确失败为 `FLOWISE_RUNTIME_MOUNT_ALLOWLIST_MISMATCH`；失败前后事故 journal/receipt 与 Flowise 容器身份均未变化。生产 Engine 对无显式 suffix 的命名卷报告 `Mode=z`，而旧校验器只接受 `rw`。

## Gate R2A：命名卷 inspect 表示兼容性修复

-   [x] 将 mount 校验拆成受审查的 Engine 表示 token 与独立安全合同：`RW=true`、唯一 volume、Type/Name/Source/Destination/Driver/Propagation、`HostConfig.Mounts` 及 `VolumeOptions={}` 继续精确绑定；拒绝任意解析/组合模式。
-   [x] 增加正反回归：受审查的 writable named-volume 表示通过；`ro`、`Z`、组合字符串、非字符串、NoCopy/Subpath/DriverConfig 漂移全部 fail closed。
-   [x] 本地 Node release `75/75`、Python `138/138`、security `337/337`、Pyright `0`、lint（0 error）、build `6/6`、真实 Docker `8/8` 与 fixture residue `0`；独立安全复审 `APPROVE`、blocker `0`。
-   [x] amendment PR `#11` 已合并为 `394ecd43265600a899e2c626f00d428301572fb1`；自动 main Node/Docker CI 与唯一人工 readiness run `30409039738` 全绿，自绑定制品已安全安装为生产候选。

## Gate R2B：数据库迁移摘要 authority 更正

-   [x] 新候选 phase1 在任何写入前以 `BOOTSTRAP_RECOVERY_DATABASE_DRIFT` fail closed；失败后容器、journal、receipt、锁与旧镜像均未变化。
-   [x] 生产只读复核确认 current database fingerprint 与 prepare baseline 四字段完全相等；误报来自 name-only 常量错误复用了 timestamp-and-name inventory digest。
-   [x] 更正常量、测试与两份事故事实文档；本地 release/Python/security/Pyright/lint/build/真实 Docker 门禁与独立复审全部通过。
-   [ ] 提交并走新的 exact-head PR/CI/readiness 与自绑定制品链路；旧 `394ecd43` 制品不得复用。

## Gate R3：生产恢复与新版本部署

-   [~] `394ecd43` 自绑定 candidate 已安装并验证，但 migration-name authority 误标导致 zero-write phase1 fail closed；待安装 R2B 自绑定 candidate 后重新执行 L3 只读门禁。
-   [ ] 先执行 zero-write `snapshot-bootstrap-recovery`，再以精确 snapshot digest 执行 `complete-bootstrap-recovery`；验证 receipt/journal owner、mode、nlink、digest 与 terminal state。
-   [ ] 重新准备新版本、执行受门禁保护的 Flowise-only cutover；失败立即走已验证回滚路径，PostgreSQL/nginx 身份保持不变。
-   [ ] 完成公网 edge、容器、日志、数据库/key continuity 与 PC 优先浏览器交互验收；不调用真实 provider，不创建或污染业务数据。
-   [ ] 稳定观察后清理本批次临时 artifact/candidate/fixture，并保留必要审计 receipt 与回滚材料。

# 2026-08-01 G1 静态中文壳层候选冻结（非完整全中文、非生产）

## Gate G1-A：所有权与原子边界

-   [x] 在独立 worktree `flowise-g1-zh` 盘点全部 tracked/untracked 差异、忽略产物与 staged 状态；原主工作区保持不变。
-   [x] 将候选拆为三个可独立回退的提交：服务端声明类型依赖、G1 中文 UI 与安全契约、计划与验证证据。
-   [x] 对共享 `pnpm-lock.yaml` 使用精确 hunk 暂存，不把两个依赖 concern 混入同一提交。
-   [x] 对全部候选执行当前树／暂存区秘密扫描、生成物检查、cached allowlist、diff-check 与三条独立复审；候选级结论为 GO。

## Gate G1-B：本地候选提交

-   [x] 原子提交服务端 `express-serve-static-core` 直接类型依赖及对应 lock importer：`5e0771cf775ddd1c047fd76a50a0943619230ca1`。
-   [x] 原子提交 10 个主模块、共享登录后壳层、关键弹窗的静态中文化，以及错误脱敏、OAuth 消息来源校验、MCP 风险提示和回归门禁：`9e17eb6afd8cc4a4bca868e8073dcec81583ed72`。
-   [x] 本计划与执行日志通过第三笔原子提交收口；提交后 staged 为空，分支仍不 push、不 merge、不生成或部署生产镜像。

## Gate G1-C：精确本地验证

-   [x] UI Jest `14/14` suites、`221/221` tests；OAuth／公开执行服务端定向 `11/11`；E2E runner 合约 `18/18`；静态安全 `341/341`。
-   [x] 全量 ESLint exit `0`（`0` error，`8` 个既有非候选 warning）；UI 与 server production build 均 exit `0`。
-   [x] 隔离 Chrome 150／Node 24.18.0 的 4 个 specs、5 个 tests 全部通过；API Key、Variable、Chatflow 与 PC core 操作全部清理，runner 回执 `status=complete`。
-   [x] 最终提交前 cached 候选为 `170` paths，二进制 diff SHA-256 `22fce841b286beb25df349ce36c4fb6669974b61d581f9de0f129c06f6dc7c04`，三条独立复审均同意 L2 候选 GO。

## Gate G1-D：后续生产边界

-   [!] 动态 metadata 已完成 15 个 Agentflow V2 节点的 910 条唯一文案、26 个类别与 114/114 凭据类的 487 条唯一文案展示投影；其余 296 个非 Agentflow 节点和 71 个动态方法仍待分批覆盖，因此不得标记为“完整全中文”，不得开始 Playbook 正式截图。
-   [!] 早期上游版本标签可达的 2023 年历史提交含疑似真实 Provider 凭据；当前树与候选命中为 `0`，但在凭据所有者提供已吊销／轮换和账单核查回执前，production promotion 保持 NO-GO；本批未调用 Provider、未改写 Git 历史。
-   [ ] 新 exact SHA 的远端 CI、不可变 `linux/amd64` candidate image、同版本隔离培训环境与 10 个主页面 Chrome/Firefox PC 验收均属于后续独立门禁。
-   [ ] 管理员凭据轮换不得写入 Git、日志或截图，必须通过受保护的生产运行时流程单独执行并保留脱敏回执。

## Gate G1-E：动态节点／凭据元数据中文展示合同（本批）

-   [x] 冻结兼容边界：`node.name/type/category`、`input.name/type/loadMethod`、`option.name`、credential component `name/credentialNames` 及默认值保持原值；不得用中文展示文案参与筛选、连接、执行或持久化判断。
-   [x] 在节点与组件凭据 API 的 clone/filter 之后附加递归 `display*` 字段；运行时 `NodesPool` 原始实例保持只读，单项查询也不得把展示字段写回共享对象。
-   [x] 为中文类别、节点、凭据、输入项、静态选项、警告、占位符和弃用提示建立确定性 catalog；未知或上游漂移文案必须显式回退并进入覆盖率报告，不得调用在线翻译服务。
-   [x] PC 端 Add Nodes、Canvas/Agentflow V2、NodeInfo、NodeInput、Credential dialog、下拉搜索与旧流程回显统一优先读取 `display*`；分组、黑名单和提交值继续使用原始字段。
-   [x] 将根节点 `hint`、复数 `outputs`、公开 flow callback、SDK `getFlowData` 和 `flowExport` 纳入同一清洗合同；仅数组形态 `outputs` 视为元数据，运行时对象形态保持原样。
-   [x] 主 UI 与独立 Agentflow SDK 的静态／异步／多选下拉均支持中文展示文案、英文原文和机器名搜索；两套 Agentflow V2 的预览边与已保存边仅做中文展示映射，搜索辅助文本、边标签和 handle 均不得污染持久化数据。
-   [x] 先收口 15 个现有 Agentflow V2 节点、全部类别及凭据入口的高频展示文案，再以覆盖率报告驱动余下节点批次；不得把局部覆盖误报为“完整全中文”。
-   [x] 增加不可变性、机器字段等值、递归投影、中英文搜索、旧流程回退及 catalog 漂移测试；通过定向 Jest、ESLint、UI/server build、静态秘密扫描与隔离 PC 浏览器主链后再原子提交。
-   [x] 已生成历史 Provider 凭据脱敏关账清单和可达性摘要；不包含原始值，且不授权 Provider 调用或 Git 历史重写。
-   [x] 精确 136 路径候选已由独立代码与安全复核确认本地 GO，并以二进制 diff SHA-256 `51c4b578006a2e0930e40a5ac41f6cb26ecf89c9138a34e31208cd3354c2a43e` 原子提交为 `0388dad97ac41f2f101864503906fe7bb04450bf`；代码审查 0 个问题，安全审查无中高危、1 个非阻断 LOW，提交后路径数和哈希复算一致。
-   [!] 所有者尚未提供吊销／轮换、使用与账单、暴露面核查回执；在受控回执完整前，production promotion 继续保持 NO-GO。

## Gate G1-F：剩余 metadata 与发布前门禁（下一批）

-   [x] 已覆盖全部 311 个节点，并用 source-hash、基线摘要、导入绑定、Map 组合与新鲜构建 receipt 的 validator 拒绝漏项、冲突和上游漂移；不可达记录与构造失败均为 0。
-   [x] 已对全局 91 个动态方法完成显式策略盘点：系统目录 51、租户透传 24、Provider 透传 16、未知 0；动态描述 137 条。
-   [x] 隔离 E2E runner 已对精确 AUT 的 HTTP(S)／WS(S) 建立 allowlist 并阻断外部端点；该证据不等同于 OS 级或所有协议完全断网，后续不得扩大表述。
-   [!] Chrome 150／Node 24.18.0 的 10 个主模块 PC 壳层及关键 CRUD 主链已通过 5 specs／7 tests；Firefox、本提交远端 CI、不可变 `linux/amd64` 镜像、历史 Provider 凭据关账、备份／回滚和生产部署验收仍是独立阻断门禁。
-   [x] 精确 45 路径候选的二进制 diff SHA-256 为 `fafdeef3f5e64b3b0fd2173ac8945e7dce721fc94744529c44dcb5abf11ff5b5`，经代码、安全和候选验证三条独立 lane 同意本地 GO，并原子提交为 `0f6354aeba2578be7f1bf0a8158988cbbfe4488c`；未 push、merge、构建镜像或部署。

## Gate G1-G：远端 CI、跨浏览器与隔离镜像闭环

-   [x] 将 G1-F 候选推送到受控分支并建立 Draft PR `zjgulai/Flowise#14`；可执行代码候选冻结为 `41e63ed3e8cdb41b9a272f1d26bc2ac9211bb2d3`，base 为 `70d8040e5ead30a7a51e2231a6a156d5632e6e25`。
-   [x] exact-head Node CI `30734841675` 全绿：冻结安装、release/security、lint、build、metadata、覆盖率与中文门禁均通过；Linux Chrome 完成 5 specs／7 tests，未出现 Google check-in 外联。
-   [x] exact-head Docker CI `30734841661` 全绿：原生 `linux/amd64` root Dockerfile build 及 canonical offline artifact／isolated runtime 验证通过；PR 条件下 upload 与 `release_readiness` skipped 属于工作流设计，不代表 registry 制品已发布。
-   [x] 当前精确代码候选在本地隔离 Chrome run `2c88108d-7eb5-4a9e-a537-229bf02a966e` 与 Firefox ESR 140.13 run `64481524-a7a4-43c7-80ce-d6a3e8e541d2` 均完成 5 specs／7 tests，runner cleanup 与 residue 检查为 0。
-   [x] GCM 最小修复的独立代码／安全复审均无 MEDIUM+；保留两项非阻断 LOW：sink 负例以静态源码合同为主，测试 helper 的 switch-key 归一化可进一步加强。
-   [!] G1-G 只证明 source、CI、build-only artifact 和隔离双浏览器候选；没有 registry 发布、main readiness、Provider 调用、生产 secret 操作、生产切换或部署后验收。

## Gate G1-H：PR Ready 后对抗性加固（进行中）

-   [x] 本地加固批次开始前，PR `#14` 为 `OPEN/Ready`，PR head 与本地提交基线均为 `48573043d5340c61c49553e97deff7141be577d5`；该状态只绑定已提交基线。
-   [x] 当前实现覆盖 workspace／capability 作用域、DocumentStore integer revision CAS 与四数据库迁移、HTTP／OpenAI／MCP 资源有界生命周期、删除／计量修正及 UI 合同；Provider 调用继续禁用。
-   [x] 已关闭独立复审发现的 Axios 编码后字节欠计、生命周期初始化清理、不可逆存储超时早退、累计下载额度和 MCP cache／空响应流清理问题；相关终审无剩余 MEDIUM+。
-   [x] 稳定实现树已通过 components `37/37` suites、`1314/1314` tests，server `133/133` suites、`1815/1815` tests，TypeScript/build、security `341/341`、release Node `77/77` ＋ Python `138/138`、metadata、E2E runner、production audit、lint／format／diff 门禁。
-   [x] 同一稳定树的隔离 Chrome 150 与 Firefox ESR 140.13 均完成 5 specs／7 tests，API Key、Variable、Chatflow、PC core 与 10 模块壳层全绿，runner cleanup 为 complete。
-   [~] 执行精确候选冻结、秘密扫描及独立代码／安全终审；全部通过才允许原子提交并推送 PR 分支。
-   [ ] 新提交推送后等待 exact-head Node／Docker CI、CodeRabbit 实质终态、全部新增讨论收口及独立 GitHub 审批；`48573043` 的既有 CI 不替代新候选证据。
-   [!] 本门禁未调用 Provider，未读取、输出或变更生产 secret，未执行生产写入或部署；merge、main readiness／制品发布、历史 Provider 凭据关账、备份／恢复、生产 key continuity 与 cutover 仍需后续独立门禁，production promotion 保持 NO-GO。

## Gate G1-J：DocumentStore 代际、租户与物化一致性加固

-   [x] 将 DocumentStore 并发身份收敛为 `workspaceId + id + generationId + integer revision`，版本指纹使用由强 `TOKEN_HASH_SECRET` 派生的 domain-separated HMAC-SHA256；Web 与独立 Worker 均在队列初始化前 fail-closed 完成密钥初始化，保持 ETag 与队列 claim wire format 不变。
-   [x] DocumentStore Loader／Vector 运行时在动态导入或 Provider 初始化前强制 workspace 归属和物化状态；Chatflow 保存／更新前解析、去重并校验 Loader、Vector、Agent 和 Retriever 的全部引用，`whereUsed` 以完整 Store 集合同步并在首个 CAS 写入前预检目标存在性与全部旧索引结构。
-   [x] 通用 DocumentStore create／update 仅接受名称和描述；loaders、whereUsed、配置、状态、revision 与 generation 由服务端所有。Loader／chunk／vector 配置变化会使物化状态转为 `STALE`，相同配置保持当前状态。
-   [x] Provider 返回元数据使用容器宽度、深度、节点、字符串与 data-descriptor 预算；超宽对象在读取任意 property descriptor/getter 前降级为空，错误和队列 envelope 只保留固定可允许状态。
-   [x] 工作区导入改为 create-only allowlist、全量 ID 重建、精确 typed-reference remap、事务内关系预检与有界批量查询；深度、节点、字节、集合、危险键和嵌入 JSON 统一预算。DocumentStore、Custom Assistant 与 `whereUsed` 在同一事务内同步，旧版 OpenAI／Azure Assistant 退出可恢复备份合同并固定返回 410。
-   [x] ChatMessage／Execution 关系按 workspace、flow、session 与父元组过滤；Evaluation 批删严格限制 UUID、去重、500 项、精确 boolean、全版本扩展上限、事务归属与 affected；CustomTool、Schedule 与 Execution 的读写和级联删除均在租户边界内 fail closed。
-   [x] Chatflow generic API 按实际类型映射 `chatflows:*`／`agentflows:*`，ASSISTANT 退出 generic 读写与 capability 路径；`mcpServerConfig` 默认 `select:false`，仅 MCP 专用授权和 Token 校验路径显式读取，MCP／Webhook 更新使用旧值 CAS、workspace／type 条件与 `affected=1`，Token 使用常量时间比较。
-   [x] 文件型认证 secret 采用 `O_NOFOLLOW`、regular-file、原子 no-overwrite 与 `0600/0700` 权限；多实例可用 domain-separated fingerprint 进行启动一致性校验。全局错误边界固定中文 5xx／Provider 401 文案、请求 UUID 和无原始异常日志。
-   [x] 当前稳定源代码树通过 server `153/153` suites、`2102/2102` tests，components `40/40` suites、`1338/1338` tests，UI `47/47` suites、`607/607` tests；三包 TypeScript／production build、security `341/341`、release Node `77/77` ＋ Python `138/138`、E2E runner `26/26`、metadata 311 节点／91 动态方法 unknown `0`、production audit high/critical `0`、候选 ESLint／Prettier／diff-check 全绿。
-   [x] 当前稳定源代码树的隔离 Chrome 150 run `1e4a257f-6fa3-47bb-991c-5f63c6b6ffc4` 与官方签名／notarized Firefox ESR 140.13 run `8382b941-e56c-4fe2-9299-1989e60196e6` 均完成 5 specs／7 tests，runner cleanup、挂载、下载、进程、端口与临时目录残留为 0。
-   [~] 冻结包含计划文档的精确路径清单与二进制 diff SHA-256，执行秘密／生成物／symlink 检查及两条独立终审；全部通过后才允许按清单原子提交并推送 PR `#14` 分支。
-   [ ] 新提交必须等待 exact-head Node／Docker CI、实质 CodeRabbit 终态和独立 GitHub 审批；既有 `48573043` 证据不能替代新候选。
-   [!] production promotion 仍为 NO-GO：Provider／存储外部副作用与最终数据库 CAS 之间缺 durable outbox／幂等 reconciliation，workspace 删除缺 tombstone/outbox，Chatflow 与 DocumentStore 使用索引仍是跨 aggregate 的提交后同步；历史 Provider 凭据关账、main readiness、备份恢复、生产 key continuity、cutover 与部署后验收也未关闭。

## Gate G1-K：工作区可移植性、MCP 与 Provider 权限收敛（进行中）

-   [x] 所有工作区导入来源在 ID 重建和数据库事务前执行组件目录驱动清洗：Flow、嵌套 Agent／Tool wrapper、Custom Assistant 与 DocumentStore 的凭据、密码、Header、MCP 和 Provider 敏感选项移除，Variable value 强制为空；受信组件的端点／主机目标为保持结构可移植性可能保留，manifest 与 UI 均要求在绑定新凭据或重新部署前逐项复核；manifest 不参与授权判断。
-   [x] 导入依赖改为完整自闭合，不再查询或绑定目标工作区既有 Flow、Tool、DocumentStore、Execution 或 ChatMessage；旧版部分导入必须重新生成 record-closure 文件。
-   [x] feedback-only 导出先取反馈再按 `messageId + chatflowid` 精确批量取父消息，消息引用的 Execution 按 ID ＋ workspace 精确批量读取；无关消息／执行超过上限不再误拒小型闭包。
-   [x] DocumentStore 执行与导出组件边界与 UI provider 列表一致：Meilisearch 的 `BaseRetriever` 合法，LlamaIndex、`documentStoreVS`、`memoryVectorStore` 和隐藏 Loader 继续 fail closed；`includeHeaders`／`splitByHeaders` 不再被误当秘密 Header 删除。
-   [x] 组件 metadata 新增显式 `workspaceExportPolicy: rebind`：本地文件／目录、数据库连接串、TLS 文件、TypeORM `additionalConfig` 和 Flow／Tool 任意 `overrideConfig` 在导出与所有导入来源中移除；受信端点／主机仍可保留但必须人工复核。8 个 `loadConfig: true` 动态子配置全部纳入同一递归清洗，空选择和未知选择均 fail closed。
-   [x] MCP 旧明文 Token 迁移改为禁用并清除，必须管理员显式重新启用并领取新 Token；公开 endpoint 不再兼容明文，Token 响应 no-store，描述上限 4,096，JSON 解析位于 bearer 鉴权／限流之后。
-   [x] MCP 公开请求在整个 `/api/v1/mcp` 命名空间、canonical casing 拒绝和 JSON parser 之前建立早期可观测边界；合法、无 ID、未授权、混合大小写、限流、超限和未知路由均只记录固定路由、方法、状态、耗时、完成类别与随机请求 ID，Prometheus／OpenTelemetry 按同一终态去重计数，chatflowId、原始路径、Header、query、body 和 Token 均不进入审计。
-   [x] Agentflow 生成、Assistant 指令生成、TTS voice、DocumentStore 工具描述、Evaluation 及仍可读的旧版 OpenAI Assistant／Vector Store Provider 路径均要求业务权限与 `credentials:view` 的合取权限。
-   [x] 更新后稳定树通过 server `162/162` suites／`2219/2219` tests、components `41/41` suites／`1339/1339` tests、UI `50/50` suites／`622/622` tests；根构建 6/6 workspace、三包 production build、release Node `77/77` ＋ Python `138/138`、security `341/341`、E2E runner `26/26`、metadata 311 节点／91 动态方法 unknown `0`、生产依赖 high/critical `0`；最终 lint／format／diff-check 随新 freeze 复算。
-   [x] 同一稳定树的隔离 Chrome 150 run `100b0677-1b71-44d1-aeb4-0f2ceeda475e` 与官方 SHA-512、SHA-256、Apple 签名及 notarization 验真的 Firefox ESR 140.13 run `fd0f645a-a91d-471f-b10d-809fc1580d3b` 均完成 5 specs／7 tests；runner、临时数据、浏览器、挂载、进程和诊断目录清理完成。
-   [x] 冻结前独立代码复核覆盖 32 个 G1-K 目标文件并允许进入全量门禁；首个 temp-index 冻结后复审继续发现并关闭 Provider-backed OpenAI Assistant 凭据权限旁路、未知 MCP 路由回落全局 parser、无 ID MCP 命名空间缺观察收据 3 个 MEDIUM，以及 audit chatflowId 高基数、Provider 畸形分页误报空文件集 2 个 LOW。旧 freeze 与哈希随即作废，更新后聚焦 `6/6` suites／`77/77` tests、ESLint、TypeScript 和复审均通过。
-   [~] 生成新的精确 temp-index 候选、路径清单与二进制 patch 哈希，执行秘密／生成物／symlink 检查和冻结后双审；旧 G1-J 全量结果和 `48573043` 远端证据不能替代。
-   [ ] 仅在新候选代码／安全双审 GO、路径与二进制 patch 哈希复算一致、真实索引仍为空后，才允许精确原子提交和 non-force push；不授权 merge、镜像发布或部署。
-   [!] `workspace:import` 明确是可引入流程、模板和 Custom Tool 代码的高信任能力，只授予受控管理员；production promotion 继续受 durable outbox、公开 BOLA／multipart、API Key、TLS、历史 Provider 凭据、main readiness、备份恢复、密钥连续性和部署验收阻断。
