---
title: Flowise 审计整改与生产验收执行计划
date: 2026-07-10
last_updated: 2026-07-12
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
