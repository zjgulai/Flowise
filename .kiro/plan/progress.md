---
title: Flowise 审计整改执行日志
date: 2026-07-10
last_updated: 2026-08-03
---

# 2026-07-10

-   已读取根/仓库工作契约、生产对抗式审计、整改计划与生产部署记录。
-   已确认 `main...origin/main` 与大规模脏工作区；本轮采用窄文件范围，不覆盖用户改动。
-   已启用证据分级：L2 本地、L3 生产只读、L4 已授权生产副作用。
-   `planning-with-files` 自带 bootstrap 路径在当前安装中不存在：`/Users/pray/.agents/skills/planning-with-files/assets/scripts/bootstrap.sh`。未重复执行相同失败动作，改为按技能约定手工建立计划文件。
-   历史阶段记录：Batch 0 生产与产品基线刷新。
-   已完成生产 API、direct port、容器、Node、防火墙和近期错误计数的 L3 刷新；未读取 env 或 secret value。
-   已完成本地安全静态门禁：14/14 通过，`git diff --check` 通过。
-   已确认本机 BuildKit 可构建 `linux/amd64`，下一步先做浏览器产品流证据，再执行本地测试和镜像构建。
-   已采集 `/signin`、`/register`、`/forgot-password` 桌面 DOM 与截图；未提交任何表单。
-   新发现生产 `/signin` 初始化 request TypeError；已加入独立调查/回归项。
-   Browser 后端不支持文档声明的 `networkidle` wait；记录一次失败后改用短延迟加新 DOM snapshot，未重复相同失败动作。
-   已采集并人工检查移动认证截图，确认 `390px` 视口横向溢出和内容裁切；已加入产品完整性 TODO。
-   桌面登录截图为空白，已拒绝作为证据，下一步重新采集。
-   已重新采集并人工确认有效的桌面登录截图。
-   已定位 sign-in TypeError 到被误翻译的 API property 标识符，并用 API module export 交叉验证。
-   已用浏览器 layout metrics 证实 `480px` 固定宽度在 `390px` 视口被裁切，不是截图主观判断。
-   已新增认证入口静态 contract，先取得 4 项失败，再完成代码修复并转为 18/18 通过。
-   已修复 sign-in API 标识符误翻译、认证页响应式宽度和 organization setup 混合标识符。
-   UI Jest 65/65 通过；Vite production build 通过，保留既有 chunk 警告作为性能债。
-   历史阶段记录：Batch 1 本地 server 门禁、local visual smoke 和 Node 24 image build。
-   用户再次明确授权下一批路线：本地 `linux/amd64` Node 24 镜像构建、制品校验/上传、生产无构建切换、验收和必要回滚。
-   已把下一批拆为 Gate A-F；当前执行 Gate A，本轮边界保持 `provider_call=false`、`secrets_read=false`。
-   `planning-with-files` 文档引用的 `references/planning-rules.md` 在当前安装中不存在；已记录一次，不再重试该路径，继续按 SKILL.md 中的规则摘要执行。
-   已完成 Docker/Compose 构建契约复核：Node 24、strict frozen lockfile、`flowise-chinese:latest`、localhost port、container healthcheck 与 amd64 builder 均满足本批前提。
-   新增后续债务：runtime image 仍包含完整编译工具链和 dev packages，本批不扩大修改范围。
-   Gate A 新鲜验证：`scripts/verify-security.sh` 18/18、`git diff --check`、server XSS Jest 34/34、server TypeScript、UI Jest 65/65 全部通过。
-   Gate A 尚待 UI production build、Compose 解析和 dirty-tree 构建清单，完成后才进入跨架构镜像构建。
-   Gate A 完成：UI production build 与 Compose 解析通过；记录 git SHA、171 个 tracked changes、27 个 untracked entries 的 dirty-tree 构建边界。
-   当前进入 Gate B 磁盘/镜像空间预检；主机数据卷仅剩约 11 GiB，尚未启动跨架构构建。
-   Gate B 空间策略确定：不删除任何 volume 或其它项目镜像；构建后使用压缩流上传，避免本地重复落盘 tar。准备启动 `linux/amd64` 构建。
-   Gate B 第一次构建在 frozen lockfile 门禁按预期失败：UI package 新增 `zod@^3.25.76`，lockfile importer 未同步。Alpine 安装阶段已成功推进，不再视为当前根因。
-   下一步只修复 lockfile 同步，保持 strict frozen install；不使用 fallback。
-   已拒绝会升级 `latest` 依赖和重写 platform metadata 的 broad lockfile 输出，并恢复原 lockfile。
-   offline filtered 方案因缓存缺 metadata 失败；切换到临时副本中的单依赖 filtered add，主仓库尚无 lockfile 改动。
-   filtered add 违反低占用预期，生成约 924 MB 临时 node_modules；已终止并清理，未修改主仓库。
-   已建立只含 Dockerfile 安装阶段 5 个 workspace manifest 的临时副本，准备测试 filtered lockfile-only install。
-   5-workspace filtered install 仍产生 127 行非目标漂移，未写回主仓库；定位到 UI manifest 的 `latest` 依赖会在任一 lockfile 更新时自动升级。
-   下一步审查新增 `zod` 的真实调用点，并决定删除误加依赖或先固定 `latest` 后再由 pnpm 生成锁文件。
-   确认 UI 有三个直接 `zod/v3` 调用点；保留 direct dependency。
-   已将两个 embed `latest` 固定为 3.1.5，并由 Node 24/pnpm 10.26.0 重新生成 lockfile；`git diff --check` 通过。
-   下一步为该固定化增加静态回归门禁，然后重跑同一 `linux/amd64` frozen build。
-   已新增三项依赖契约静态检查，`verify-security.sh` 21/21 通过，准备第二次 `linux/amd64` frozen build。
-   第二次构建：frozen install、sqlite3/faiss prebuild 通过；UI clean build 因缺少 direct `@uiw/codemirror-theme-sublime` 失败。
-   已确认 theme dependency 和 lock importer 本来就存在，撤销“漏声明”假说。
-   当前调查 Dockerfile 的 5-workspace install 与 Vite root alias 的 hoist layout 不一致；先对照原始/upstream 构建方式，再选择单一修复。
-   原始 Dockerfile 证实完整 workspace install 是既有行为；已在多阶段 Dockerfile 补入 agentflow/observe manifests，并增加两项静态检查。
-   修复后静态门禁 23/23 通过；第三次构建前先释放可回收 BuildKit cache，保护约 9.1 GiB 的剩余磁盘。
-   已只清理 2.786 GB reclaimable BuildKit cache；未删除 image/container/volume，可用空间恢复到约 11 GiB。
-   当前启动第三次 `linux/amd64` 构建，验收点是 install scope=7 且 UI root alias 可解析。
-   第三次构建证伪完整-workspace-hoist 假说：scope=7 后 root `@uiw/react-codemirror` 仍不存在。
-   已达到同类问题第 3 次验证门槛；暂停 alias patch，进入 deps stage 文件系统诊断。
-   deps image 导出导致磁盘最低约 804 MiB；已终止挂起命令并删除调试镜像，恢复到约 4.4 GiB。
-   诊断方式切换为不导出镜像的 BuildKit `deps-check`，仅检查 symlink 布局。
-   `deps-check` 已完成：root alias 目标全部缺失，UI direct `@uiw/*` symlink 存在。进入 import/dependency contract 盘点。
-   import 盘点完成并修复 Vite resolver：移除 root-hoisted editor aliases，未新增无直接 import 的依赖；临时 diagnostic stage 已清理。
-   resolver 修复后本地静态、UI Jest、Vite build、diff check 通过；下一步执行 clean deps 的 builder-only target。
-   clean builder 证明 UI resolver 修复生效；构建现推进到 components TypeScript dependency/type errors。
-   下一步盘点 components manifest、lock importer 和每个失败 import，先修模块依赖契约，再处理剩余真实类型错误。
-   已确认多数失败 import 是 components 对 server/transitive hoist 的隐式依赖；下一步分离 direct dependency 修复与 uuid/Mem0 类型兼容问题。
-   本地 tsc 绿、clean tsc 红的差异已确认是 hoist 隐藏；将补齐 components direct/runtime/type dependencies，并单独修复 Mem0 重复继承。
-   已确定 uuid types 与 Mem0 版本边界；正在执行 components AST import/dependency 全量差异扫描。
-   components AST 扫描识别出 14 个未直接声明的外部 import，但进一步对照 `.npmrc` 与上游 Dockerfile 后确认本轮 clean build 的首要根因是依赖阶段漏复制 `.npmrc`，导致既有 `shamefully-hoist` workspace 布局未生效；未扩大为 14 个依赖的猜测性 manifest 修改。
-   已在 Dockerfile frozen install 前复制 `.npmrc`，并把该契约加入静态门禁；`scripts/verify-security.sh` 25/25、`git diff --check` 通过。
-   已清理 8.03 GB 可回收 BuildKit cache；未删除 image、container 或 volume。
-   干净 `linux/amd64` builder-only 构建通过：frozen install scope=7，sqlite3/faiss-node 使用 linuxmusl-x64 prebuild，components/UI/server/API 4/4 workspace 构建成功。
-   当前进入 Gate B 最终 runtime image build/load；构建使用唯一 tag，不覆盖本地既有 `latest`。
-   最终 runtime image 首次镜像内验收发现 CMD 仍为 `pnpm start`，但 runtime stage 未安装 pnpm；候选镜像未部署。已用真实 Node/Oclif 入口 `node packages/server/bin/run start` 在 `network=none` 下取得 `pong` 后修正 Dockerfile CMD，并增加两项静态门禁。
-   以已验证 rootfs 为只读 base 生成 config-only v2 镜像；本地/远端均验证 `linux/amd64`、Node `v24.18.0`、无 AppleDouble、默认 CMD 可启动并返回 `pong`。
-   Gate B 制品：`flowise-chinese:node24-20260710-authorized-v2`；压缩制品 1,132,842,786 bytes；双端 SHA256 `8ba7158f88f13411a5f5e609d96ed29abd311d51745401507824521f4b8810a4`。
-   Gate C 备份完成：`/opt/flowise/backups/authorized-node24-20260710T053915Z`；旧镜像保留为 `flowise-chinese:rollback-20260710T053915Z`。防火墙导出首次因普通用户权限失败，随后用 `sudo -n` 补齐同一备份，生产当时未变化。
-   第一次 Node 24 切换容器 health 与 host-local `/ping` 通过，但外部 HTTPS 返回 502；按门禁立即恢复旧 compose/env/image，旧 Node 20 容器和 HTTPS `pong` 恢复。
-   502 根因已用生产拓扑证实：80/443 由容器 `ai_video_nginx` 持有，其 `flowise_app` upstream 固定为 `172.20.0.1:3000`；绑定 `127.0.0.1` 只对宿主可见，代理容器无法访问。
-   Compose 改为 `${FLOWISE_BIND_IP:-127.0.0.1}:3000:3000`，生产设置 `FLOWISE_BIND_IP=172.20.0.1`，并显式保留 `lighthouse_ai_video_net` 外部网络。独立候选容器在私有 `172.20.0.1:13000` 上被 Nginx 容器访问并返回 `pong`。
-   第二次切换联合门禁通过：container health、gateway `/ping`、Nginx upstream `/ping`、公网 HTTPS `/ping` 全部为 `pong`；Node `v24.18.0`、image ID `sha256:3c66e08b...fad9`、端口仅 `172.20.0.1:3000`，restart count 0。
-   L4 API：GET `/api/v1/auth/resolve` 为 405 且无内部标记；POST 为 200、`redirectUrl=/signin`；非法 Origin preflight 无 ACAO；公网 `:3000` 连接拒绝。
-   L4 日志：Node engine、AppleDouble、auth-secret 和 TypeError 四类匹配均为 0。
-   L4 浏览器：`/signin` 1440 与 390px 无横向溢出，关键控件均在视口内，console 0 error/0 warning；`/register` 自动跳转 `/signin`；`/forgot-password` 390px 无溢出且未提交表单。
-   生产仍有 HSTS、X-Content-Type-Options、Referrer-Policy 各重复 2 次，保留到 Batch 6 header owner 治理；登录后核心 E2E 与 provider mock 仍未执行。
-   对抗式复核补充发现：`X-Frame-Options` 同样重复 2 次；CSP 仅由 app 输出一次。Batch 6A 被选为本轮无需账号/provider 的可独立部署批次。
-   新增 `scripts/verify-production-edge.sh`；首版因 macOS Bash 3.2 不支持 `${var,,}` 暴露脚本可移植性问题，改用 `tr` 后修复前稳定得到 10 passed、4 failed。
-   Header contract 确定为：Nginx 拥有 HSTS/XFO/XCTO/Referrer，app 拥有 CSP 并保留 direct-deploy fallback；候选 Nginx diff 仅位于 Flowise 专属 `location /`，`nginx -t -c` 通过。
-   首次用 `install` 替换宿主 Nginx 配置后 reload，四头基数门禁失败并自动回滚。根因是单文件 bind mount 仍指向旧 inode；宿主与容器 inode 证据不同，服务始终健康但候选未生效。
-   Compose config 通过后，最终以 `--no-deps --force-recreate nginx` 只重建共享代理。持久化源与容器配置 SHA256 同为 `7a67c22f...02b23`，回滚备份为 `/opt/ai-video/deploy/lighthouse/backups/nginx.conf.20260710T080129Z.flowise-header-owner-recreate`。
-   Batch 6A L4：edge smoke 14/14、静态门禁 33/33、`git diff --check` 通过；Flowise/Nginx restart 0，日志目标错误 0，共享 video health 200，HTTP 301、公网 3000 拒绝连接。
-   浏览器 L4：`/signin` 1440 与 390px console 0 error/0 warning；移动 `clientWidth=scrollWidth=390`、视口外控件 0。有效截图保存在 `output/playwright/production-edge-header-20260710/.playwright-cli/`。
-   Batch 4 仍受测试账号/隔离 workspace/安全凭证交付路径阻塞；下一可执行批次调整为 Batch 5A provider mock contract，继续保持 `provider_call=false`、`secrets_read=false`。
-   Batch 5A RED 基线：共享 helper 缺失；DeepSeek 10 failed/1 passed；Kimi 17 failed/3 passed；模型目录 3 failed/2 passed。测试全程替换 global fetch，未发生真实 provider 请求。
-   已新增共享 provider helper：HTTPS/origin allowlist、URL credential/query/fragment 拒绝、header validator、严格数值解析、空 credential fail-fast 与 `secureFetch` 注入；helper 24/24 通过。
-   DeepSeek 根因修复：当前 `@langchain/deepseek` 只读取 `apiKey`；节点改为 V4 默认、required credential、严格参数、官方/allowlist endpoint、thinking/reasoning 和安全 transport。
-   超时测试首次超过 Jest 5 秒；追踪 OpenAI SDK 与 LangChain 源码确认 SDK `maxRetries=0` 外仍叠加 LangChain `AsyncCaller` 默认 6 次重试。两个 provider 节点现显式 `maxRetries=0`，同一路径转绿且单次 transport 尝试约 33ms 结束。
-   Kimi 节点改为 required credential、K2.6 默认、thinking、K2.7/K2.6/K2.5 固定参数校验和安全 transport；SSE fixture 改用 Web `ReadableStream`，取消测试等待 transport 启动后再 abort。
-   最终官方复核发现 K2.6/K2.5 也有固定采样约束；新增测试先取得 5 failed/24 passed，再实现 thinking=true 时 temperature=1、thinking=false 时 0.6、top_p=0.95、penalty=0，Kimi 套件转为 29/29。
-   模型目录加入 DeepSeek V4 Flash/Pro 与 Kimi K2.5/K2.6/K2.7；DeepSeek 旧 aliases 保留并标注 2026-07-24 Legacy，目录 contract 5/5 通过。
-   配置闭环：`.env.production.template` 与 Compose 增加空值默认的 provider endpoint allowlist；静态门禁新增四项 key 透传检查。
-   文档闭环：新增 `docs/ops/flowise-provider-nodes-maintenance-20260710.md`，旧 Kimi/DeepSeek 指南标记为历史快照，并从仓库 `AGENTS.md` 挂接当前维护入口。
-   compiled-load smoke 首次发现 DeepSeek 的 timeout 毫秒说明误放到 Max Tokens；metadata 测试先取得 1 failed/10 passed，移动说明后 DeepSeek 11/11 并重新构建通过。
-   Batch 5A L2：provider 定向 69/69，完整 components Jest 24 suites/943 tests；TypeScript、focused lint、components build、compiled-load smoke、静态门禁 37/37、Compose template parse、`git diff --check` 全部通过。
-   compiled-load smoke 仅读取构建节点 metadata：DeepSeek `deepseek-v4-flash`/`https://api.deepseek.com`，Kimi `kimi-k2.6`/`https://api.moonshot.cn/v1`，credential 均 required。
-   Batch 5A 边界：`provider_call=false`、`secrets_read=false`、`production_write=false`；没有真实 provider 调用或生产部署。
-   后续 Batch 5B：真实 sandbox smoke 与认证 UI 等待单独授权/测试身份；本地可继续补 K2.7 `tool_choice`、`reasoning_content` 端到端和成本 schema。
-   Batch 6B 从对抗性 RED 开始：现有 iframe parser 会保留危险输入且静默回退，结构化 CSP/report receiver 尚不存在；测试先覆盖 injection、clickjacking、downgrade、oversized telemetry 与敏感日志边界。
-   已实现严格 `IFRAME_ORIGINS` exact-origin parser、`compat -> no-eval -> strict-script -> strict` 单调 CSP 模式、绝对同源 Reporting endpoint、16 KiB/120 rpm/脱敏 report receiver，并把 UI inline bootstrap 外置到 `/global.js`。
-   本地 production-mode fixture 首次启动因隔离 secret 目录父目录不存在而失败；创建仅位于 `/tmp` 的隔离目录后同一路径继续，不读取仓库或生产 secret。
-   report-only fixture 首次暴露 `express-rate-limit` 的 `ERR_ERL_PERMISSIVE_TRUST_PROXY`；根因是 `TRUST_PROXY=true` 可绕过基于 IP 的限流。现改为启动阶段 fail-fast，并用明确 hop count `TRUST_PROXY=1` 完成本地验收。
-   完整 server Jest 首轮发现 `chatflows/index.test.ts` 的 `uuid` 局部 mock 缺少 `v4`，单套绿但全量顺序失败；补齐 mock 合约后最终 33/33 suites、967/967 tests 全绿。
-   Batch 6B L2 自动化：server focused suites、TypeScript、focused ESLint、server build、UI Jest 65/65、UI production build 21176 modules、静态安全 52/52、Compose template render、`git diff --check` 全部通过。
-   隔离 HTTP smoke 验证 `compat` enforcement、`no-eval` report-only、exact `frame-ancestors`、绝对 `Reporting-Endpoints`，以及 report `204/400/413` 和 rate-limit headers；非法 report mode/不受限 proxy trust 均在业务 handler 前失败。
-   浏览器 `/signin` 正常渲染，console 0 error/0 warning；`ReportingObserver` 捕获真实 `script-src` report-only violation。自动后台 POST 在本地 HTTP 环境未观测到，因此没有把 violation generation 误记为 delivery 成功。
-   build scan 发现 4 个 chunk 共 8 处 `Function("return this")` 与 1 处 regenerator fallback；`no-eval` enforcement 当前被实测阻塞，后续必须覆盖认证后 lazy workflows 的生产 report-only 观察。
-   Batch 6B 仅完成本地 L2：`production unchanged`、`provider_call=false`、`secrets_read=false`、`production_write=false`。Batch 4 测试身份阻塞与 Batch 5 真实 provider 授权边界保持不变。

# 2026-07-12

-   启动 Stage 0 release foundation：branch `codex/flowise-release-foundation-20260712`，base `bb773ffa710bd22639c4ba2643413a0ea2b679d3`。
-   Task 1 source boundary commit `92f8891` 已通过独立复审。
-   Task 2 UI/auth 共 6 commits、162 unique paths，测试/build/security gates 与复审通过。
-   Task 3 runtime source commits `51e802e`、`e6d2587` 已通过代码复审；Docker registry metadata/DNS 阻塞 image/runtime verification。
-   Task 4 Provider commit `b73a3c89586de994bc840cfb8dff50a27d81c057` 已通过 Provider tests `225/225`、TypeScript、focused lint、components build、static security `52/52`、compiled-load smoke 与独立复审；`provider_call=false`、未部署。
-   Task 5 CSP/request commit `137256127d42e787faaa0292e56bb8d4da75ace6` 已通过 server `127/127`、UI `65/65`、TypeScript、focused ESLint、UI build、static security `52/52` 与独立复审；复审修复确保早返回的 CSP report 响应也保留统一安全头；未部署。
-   Task 6 release provenance commit `699b59b1c08413e0785a9732c2dfe4c020b4a331` 已通过 release tests `18/18`、source gate、static security `95/95`、Compose render、clean-clone frozen install 与两条独立复审 lane。
-   Task 6 单次 Docker 尝试在 Dockerfile evaluation 前解析 pinned registry index 时返回 `EOF`，未重试；`docker_build_verified=false`、`builder_image_verified=false`、`final_image_loaded=false`、`runtime_smoke_verified=false`、`actual_archive_manifest_verified=false`。
-   Task 1-6 source/config range 共 12 commits、212 changed paths。Task 7 编辑前快照为 `tracked_changed_paths=2`、`untracked_paths_all=32`、`cached_paths=0`；该计数按 `git diff --name-only`、`git ls-files --others --exclude-standard` 和 cached diff 分别取得。
-   Public read-only L3 `2026-07-12T10:48:40Z`：edge smoke `14/14`；HTTPS ping `200 pong`、signin `200`、HSTS/XFO/XCTO/Referrer/CSP 各 1、auth GET `405` 且无内部标记、auth POST `200` 指向 `/signin`、恶意 Origin 无 ACAO；CSP Report-Only 与 Reporting-Endpoints 均为 0，现行 CSP 仍含 `unsafe-eval`；公网 `3000` HTTP `000`、TCP refused。
-   SSH read-only L3 `2026-07-12T10:51:01Z`：Flowise running/healthy、restart `0`、Node `v24.18.0`、`linux/amd64`、bind 仅 `172.20.0.1:3000`；Nginx/Postgres healthy。
-   生产 config image reference 仍为 legacy `flowise-chinese:latest`；image ID `sha256:3c66e08b50562ab856328d669b611d000ccee6c9467f1560b7b8b4ba0b86fad9`，created `2026-07-10T05:32:55Z`。RepoDigests 与 OCI source/revision/version/created/ref labels 为空，因此该生产镜像不满足 Task 6 immutable provenance contract。
-   远端只验证到备份目录存在：`backup_state=exists_not_checksum_or_restore_verified`。
-   Task 7 开始同步 9 个 current-state 文档；历史 root reports、`pnpm-lock.yaml`、Docker variants、sidecar 文件保持未暂存。
-   Stage 0 全程 `production unchanged`、`production_write=false`、`provider_call=false`、`secrets_read=false`、`registry_push=false`。
-   Task 7 九个文档路径已通过 stale-state、Markdown 格式、精确 cached allowlist 与两条独立复审；`pnpm-lock.yaml`、历史 root reports、Docker variants 和 upload sidecars 未进入提交边界。
-   Task 8 初次 whole-branch review 发现 Docker context/manifest 漂移、encryption key 非持久化、Compose env 未生效、`global-agent` 覆盖 DNS-pinned Agent，以及 text-only Compose gate 可假绿；全部以 RED 证据和最小修复闭环。
-   Task 8 修复 commit `75f75f48622bcc213c4eb99388a147ff5213aaf6` 精确包含 13 个路径；用户 `pnpm-lock.yaml` 与历史/备用文件未暂存。三条独立复审 lane 最终均 APPROVED，无剩余 Critical/Important。
-   Clean clone 使用 Node `v24.18.0`、pnpm `10.26.0`，frozen install 后 lock hash 不变；release `19/19`、static `114/114`、components `24/24` suites / `1018/1018` tests、server `35/35` / `1004/1004`、UI `2/2` / `65/65`、`build:docker` `4/4`，source/Compose/TypeScript/lint/format/diff gates 通过。
-   生产只读 follow-up 仅确认当前 `encryption.key` 位于 `/home/node/.flowise` 容器层而非 `/usr/src/flowise/.flowise` 持久卷，未读取值。未来 recreate 必须先经单独授权复用旧 key；`production unchanged`、`secrets_read=false`。
-   Task 8 未重试真实 Docker build；registry `EOF` 证据边界保持：`docker_build_verified=false`、`builder_image_verified=false`、`final_image_loaded=false`、`runtime_smoke_verified=false`、`actual_archive_manifest_verified=false`。

# 2026-07-28/29 Bootstrap Recovery Checkpoint

-   从精确断点恢复到独立干净 worktree `/Users/pray/project/FlowAgentic-flowise-legacy-bootstrap`，branch `codex/flowise-bootstrap-recovery-20260728`，base `56196c3cb4a3123f657614274a2227071920ba01`；原 dirty repo 未改动。
-   当前生产仍为旧 Flowise 容器 `953d213d666de29fde0b99f4a908ca46e7d642f8bd3126235e8284f82d5e7e39`、旧 image `flowise-chinese:git-c947339b7033c930be37591918f59c7725800bbe`，只读复核为 running/healthy、restart `0`，private/public ping 均为 `pong`。
-   失败的 run `20260728T171644Z-4914e862` 保持 `hardened_recreate_intent`；禁止重放旧 bootstrap、禁止通用 bootstrap rollback、禁止手工 Compose/文件绕过。
-   新增 incident-only `snapshot-bootstrap-recovery` / `complete-bootstrap-recovery`：exact topology、existing lock、双观察、完整 runtime/data/key/network/sidecar authority、不可覆盖 receipt、journal preimage CAS、回读和 terminal idempotency 均已实现。
-   对抗修复闭环：Config 17-key/HostConfig 66-key exact surface、type-exact StartInterval、image Env + Compose overlay、单次 live-file bytes/seccomp 观察；已知 HostConfig 和类型混淆攻击全部拒绝。
-   最终冻结 wrapper SHA256 `32578ddc632594933fc24c9c3fcc5692f845e8c6c9f4f1c812a7ff9260ce86c7`；unit test SHA256 `3ec77258c3319b3c4d478f318f959982ca02d76cfa388d5982f85d11fa53b34f`；integration test SHA256 `4fddb5d22fedcc98da8d9cd44f60bdf2e26737bf8a6aa5418737960b718a8bc6`。
-   本地 L2：Node 24.18.0 release tests `75/75`、Python `137/137`、security `337/337`、Pyright `0`、py_compile/diff-check 通过；真实隔离 Docker boundary `8/8`，fixture residue `0`。
-   独立 security counter-review 已 `APPROVE`，risk `LOW`，Critical/High/Medium `0`；未发现真实 secret，依赖 manifest/lockfile delta `0`。
-   当前边界：PR `zjgulai/Flowise#10` 已包含第四笔 Chatflow alias 稳定性 commit `2badd4a243037dd4643cfbf5d574b3f99239f489`；该 exact head 的 Docker CI `30398824478` 已通过。Node CI `30398824398` 的 frozen install、release contracts、lint、build、coverage、API key、variables 与 PC core 均通过，仅 Chatflow 在原始保存 POST 成功后首次硬 `cy.visit(/canvas/<id>)` 发生 60 秒 page-load timeout；afterEach 仍可 GET/DELETE 原记录，因此不是持久化失败。第五笔 test-only 候选已等待 `Chatflow saved` 并改用列表内 SPA reopen/copy，本地双轮聚焦、四套件全量 Chrome、release/security/build/static 均通过；独立复审 `APPROVE`，唯一 LOW 已以精确初始 `cy.visit('/canvas')` 合同关闭，修改后精确门禁再次全绿，待原子提交。PR 尚未 merge，仍未生成包含 recovery 命令的自绑定 artifact，也未对生产执行 recovery、cutover 或浏览器验收；`production_write=false`（本恢复批次开始以来）。
-   下一门禁：原子提交第五笔候选并等待新 exact-head CI 全绿 -> merge -> main 手工 readiness artifact -> production recovery terminal closure -> 新版本 cutover -> PC-first browser acceptance -> cleanup。
-   PR `zjgulai/Flowise#10` 的首个 exact commit `cea60f7aa887a354ee6516d6d318f85ed29fefdd` 已触发 Node CI `30391562893` 与 Docker CI `30391562760`；两者均只在同一 Python test 的 macOS-only `/private/tmp` hardcode 失败，Node release contracts `75/75` 已通过，未进入 build/cutover/production 路径。
-   CI portability 修复仅修改 lock no-create/no-follow 测试：选择现存、非 symlink、root-owned、权限安全且可写的系统 temp parent，并显式保持 `LOCK_PATH` 在独立 `BASE_DIR` 外；macOS full release tests 与无网络、只读 Linux container focused probe 均通过。下一步提交该最小修复并等待新 commit 的两条 CI 从零重跑。
-   Portability commit `c2af846d635ed5dbdbbf97b84e1d99514f671ac4` 的 Node CI `30392075283` 与 Docker CI `30392074876` 均为 success；后者已完成 root Dockerfile build、offline artifact 和 isolated runtime 验证。该证据仅绑定 `c2af846d`，不替代后续 head CI。
-   CodeRabbit 复核确认一个 metadata self-attestation 缺口：旧 `_live_seccomp_canonical_digest` 以攻击者可变 lstat metadata 反向授权读取。生产 L3 显示真实文件为 `1000:1000/0644`，因此否决会误伤生产的 root-only 建议；候选改为复用既有 `(0,0)/(1000,1000)` owner allowlist、固定 `0644`、2 MiB 上限和非空校验。`com.docker.compose.replace` 放宽建议被独立审计判定为 false positive，现网与五条支持路径均要求 recreate lineage，保持 exact 16-label contract。
-   审查候选本地门禁更新为 Node `75/75`、Python `137/137`、security `337/337`、Pyright `0`、py_compile/diff-check；文档已把 `32578dd` 正确表述为本地 wrapper SHA-256 prefix，而非 Git revision。独立安全复审最终 `APPROVE`：原 MEDIUM 已闭环，剩余风险 LOW。
-   新 owner allowlist 使 macOS UID 501 的真实 Docker fixture 首次按预期失败且 trap 清理为零残留；仅在 BoundaryHarness 内加入 scoped unprivileged reader，并以 observation 前固定的 root FD、逐组件 `dir_fd + O_DIRECTORY + O_NOFOLLOW` 与末级前后 identity 关闭父路径竞态。最终 SHA 重跑真实 Docker `8/8`、fixture residue `0`；生产 wrapper owner allowlist 未放宽。第三个原子修复 commit 为 `bbc4b444264300b01b8dadcb2ce956aeee656eb7`。
-   `bbc4b444` 的 Docker CI `30395885548` 已 success（root Dockerfile、canonical offline artifact、isolated runtime）；CodeRabbit 已 pass。Node CI `30395886019` attempt 1/2 均通过 release contracts、lint、build 与 coverage，仅 Chatflow Cypress 失败：首次后端已收到 DELETE 但 `deleteChatflowCopy` alias 未捕获，第二次后端已收到 POST 但 `createChatflow` alias 未捕获。两次不同 alias 的同型证据确认测试同步脆弱，而非本批 production/release 代码回归；停止盲目重试。
-   test-only 候选保留真实 UI create/copy/delete/reopen 与 forbidden-path middleware，去除 CRUD/reopen/loadNodes 的网络 alias，改为 save 后 `/canvas/<id>` + API 回读、delete 后 `/` + 有界 404 回读；runner contracts `18/18`、focused ESLint、Prettier、node/diff-check 与完整 build 已通过，独立复审 `APPROVE`、最高严重度为无。
-   本地 Chrome 150/Node 24.18.0 在两个独立新 SQLite 数据库上各完成一次聚焦 Chatflow E2E，均为 `1/1`；刻意复用首轮数据库的额外进程只在 auth fixture 失败，证实 `cypress.config.ts` 的每进程 `randomBytes` 密码不支持跨进程复用，未进入 Chatflow 流程且不计入产品失败。两轮临时数据库、密钥、截图目录已盘点并精确删除，端口 3000 无残留监听。
-   第四笔候选的提交前精确门禁：release Node `75/75` + Python `137/137`、security `337/337`、E2E runner `18/18`、focused ESLint/Prettier/node syntax、完整 workspace build `6/6`、`git diff --check` 全部通过；依赖与 lockfile 无改动。
-   第四笔 commit `2badd4a243037dd4643cfbf5d574b3f99239f489` 的 Docker CI `30398824478` 全绿；Node CI `30398824398` 仅在 Chatflow 首次 reopen 的硬页面加载超时，其余任务和 specs 全绿。没有盲目重试或放宽 `pageLoadTimeout`，而是依据成功 POST、可回读/删除记录与失败位置确定 UI 保存稳定化和硬导航之间存在 hosted Chrome 时序竞态。
-   第五笔候选在 create 后等待 `Chatflow saved`，reopen 通过返回流程列表、搜索名称并点击进入，copy 通过返回列表并点击“新增流程”进入空 canvas；全 spec 仅保留首次启动时一个 `cy.visit('/canvas')`。两次诊断过程分别暴露隐藏侧栏文本命中和删除后已位于 `/` 时无返回按钮，均已修复且不计入通过证据。
-   第五笔最终浏览器内容在两个独立 fresh runner 上的聚焦 Chrome 各为 `1/1`，四套件全量 Chrome 为 `5/5`（Chatflow `1/1`、PC core `2/2`）；每轮数据库、密钥、截图与进程均由 runner 完成清理。release Node `75/75` + Python `137/137`、security `337/337`、E2E runner `18/18`、完整 build `6/6`、focused static/diff-check 全绿；独立复审 `APPROVE`，唯一 LOW 要求静态合同锁定唯一一次 `cy.visit` 必须为初始 `/canvas`，已补强。补强后的同一精确代码内容再次通过上述全部门禁，复审确认 Critical/High/Medium/LOW 均为 `0`；不能以本地证据替代新 commit CI。

# 2026-07-29 Production Recovery Mount-Mode Amendment Checkpoint

-   第五笔修复已提交为 `7c650142f5cda0833834582e940a4ea18dbec459`；exact-head Node CI `30400942705` 与 Docker CI `30400942552` 均 success，PR `#10` 合并为 `b9070d7d6dea20696e1dc40df47510f0b7039d3c`。
-   `main` readiness run `30402079400` 是该 merge SHA 唯一人工触发：build 与 release_readiness 均 success；本地独立验证 config digest `sha256:35252757371dfd6e42bb40a64533f2279c39c12f7a44198efe85901139e03df2`、bundle digest `sha256:fd1171968eadb9b4ca713ecb946710dad8dadb38cc157b794f9155699bad23e5`。
-   精确制品已通过 no-clobber staging 安装到 `/opt/flowise/candidates/git-b9070d7d6dea20696e1dc40df47510f0b7039d3c`；仅新增候选文件，未切换 runtime/config/database。
-   生产 fresh L3 保持旧 Flowise container `953d213d666de29fde0b99f4a908ca46e7d642f8bd3126235e8284f82d5e7e39` running/healthy、restart `0`，host/proxy/public ping 均为 `pong`，edge smoke `14/14`。
-   `snapshot-bootstrap-recovery` 以 zero-write 路径失败并返回 `FLOWISE_RUNTIME_MOUNT_ALLOWLIST_MISMATCH`；完成 receipt 仍不存在，事故 journal 保持 `bootstrap|in_progress|hardened_recreate_intent` 与原 digest，Flowise 容器身份/健康/restart 均未变化。
-   根因是 Docker Engine 对 Compose 无显式 volume suffix 的相同可写 named-volume 合同，在生产 `.Mounts[].Mode` 报告 `z`；Flowise 与 PostgreSQL 均呈现该 Engine 行为，而 `HostConfig.Mounts` 仍为唯一 named volume、`VolumeOptions={}`。旧 validator 只接受 `rw`，属于 inspect 表示可移植性缺陷，不是 runtime drift。
-   新分支 `codex/flowise-volume-mode-recovery-20260728` 基于 clean `origin/main`；候选修复仅修改 wrapper 与单测。它对受审查 mode token 做精确 membership，不解析任意组合，并独立强制 `RW=true`、唯一 Type/Name/Source/Destination/Driver/Propagation、exact `HostConfig.Mounts` 与空 `VolumeOptions`。
-   安全复核将本次恢复权限进一步收紧为仅接受本项目 fixture 已验证的 `rw` 与生产实证 `z`；空字符串未纳入。新回归覆盖 `ro`、空字符串、`Z`、组合字符串、非字符串、NoCopy、Subpath escape、DriverConfig 注入拒绝。
-   当前精确内容通过 Node 24 release `75/75`、Python `138/138`、security `337/337`、Pyright `0`、py_compile、lint（0 error/8 个既有 warning）、full build `6/6`、diff-check；`pnpm audit --prod --audit-level high` exit `0`，仅报告 low/moderate、无 high/critical。
-   真实 Docker legacy bootstrap boundary 在收紧后的精确内容上 `8/8`，测试后 `flowise-bootstrap-it-` 前缀 container/volume/network/image 残留均为 `0`；独立安全复审 `APPROVE`、confidence high、blocker `0`。尚未 commit/push，未执行 amendment CI/readiness，也未再次触碰生产。
-   提交前冻结 SHA-256：wrapper `692cfca5a81b4fff06914cc72a3d7672aa260717f5b88e181b09a683b807026c`，wrapper tests `e13610273335f5a437f251614e6c8d0bd026ea277ff42a03f7383c1f25cc8702`。

# 2026-07-29 Production Recovery Migration-Digest Correction Checkpoint

-   mount-mode amendment commit `d6e682f3cebf392e6946659e07efacc506e8b01f` 经 PR `#11` 合并为 `394ecd43265600a899e2c626f00d428301572fb1`；自动 main Node/Docker CI 与唯一人工 readiness run `30409039738` 全绿。
-   release artifact `8707955998` 绑定 exact run/SHA，安全下载后通过 CRC、7-file allowlist、manifest、deployment bundle 与关键文件 byte comparison；随后以 root-only staging 安装到 `/opt/flowise/candidates/git-394ecd43265600a899e2c626f00d428301572fb1`，生产 runtime/config/database 尚未切换。
-   fresh L3 精确确认旧 Flowise/PostgreSQL/Nginx identity、健康、restart、journal digest、completion 缺失和 lock availability 后，`snapshot-bootstrap-recovery` 在 zero-write 边界返回 `BOOTSTRAP_RECOVERY_DATABASE_DRIFT`。
-   失败后容器、旧镜像、journal、completion 和 lock 再次只读核对均未变化。current database fingerprint 与 prepare baseline 完全相等：migration count `59`、timestamp-and-name digest `sha256:a30f16eb1af7cb810e97cd45df464e97255d9bc8a2d9aaabbac8787b4396b5b6`、name-only digest `sha256:2b3bbc851e962ef6a317697f851890ebe5e9b193ebfe50aacf47446fcdf0cbb5`。
-   根因是 recovery 常量把 timestamp-and-name digest 误标为 name-only digest；当前分支 `codex/flowise-recovery-migration-digest-20260729` 仅更正 authority 常量、回归断言和事实文档，不修改数据库查询、比较逻辑或任何生产状态。
-   当前精确补丁通过 Node 24 release `75/75`、Python `138/138`、security `337/337`、Pyright `0`、lint `0 error`（8 个既有 warning）、workspace build `6/6`、production audit `0 high/critical` 与真实 Docker boundary `8/8`；fixture residue 为 `0`。独立代码追踪与最终复审均 `APPROVE`、blocker `0`。

# 2026-08-01 G1 静态中文壳层候选闭环

-   在独立 worktree `/Users/pray/project/FlowAgentic/flowise-g1-zh` 与分支 `codex/flowise-g1-zh-20260801` 执行，base 为 `70d8040e5ead30a7a51e2231a6a156d5632e6e25`；原主工作区未纳入本批操作。
-   第一笔原子提交 `5e0771cf775ddd1c047fd76a50a0943619230ca1` 只收口 server 声明类型直接依赖及 lock importer；第二笔 `9e17eb6afd8cc4a4bca868e8073dcec81583ed72` 收口 170 个 UI／安全／回归路径。
-   第二笔提交前二进制 diff SHA-256 为 `22fce841b286beb25df349ce36c4fb6669974b61d581f9de0f129c06f6dc7c04`；pre-commit 的 pretty-quick 和 lint-staged 均通过，提交后 commit diff 哈希不变。
-   安全闭环包含：公开执行 API 仅接受 `/:id` 并在查库前校验 UUID；公开 404／500 使用固定文案；执行错误字段与 SourceDoc JSON 递归脱敏；OAuth popup 校验 origin、source、credential ID 与 schema；SSE／TTS 终止及资源所有权 fail-closed。
-   自动化证据：UI Jest `14/14` suites、`221/221` tests；server OAuth／public execution `11/11`；E2E runner `18/18`；静态安全 `341/341`；全量 ESLint exit `0`（`0` error，`8` 个候选外既有 warning）；UI/server production build 均 exit `0`。
-   隔离 Chrome run `251b11e5-6e52-4234-9afc-c834e24a0d37` 在 Chrome 150／Node 24.18.0 上通过 4 specs、5/5 tests：API Key `1/1`、Variable `1/1`、Chatflow `1/1`、PC core `2/2`；runner 最终 `phase=cleanup status=complete`。截图仅作临时运行证据并随隔离目录清理，不是 Playbook 正式截图基线。
-   代码复审、候选验证与安全终审三条独立 lane 均同意 exact L2 候选 GO；安全终审结论为候选风险 LOW、Critical/High/Medium 阻断为 `0`。
-   动态 metadata 审计仍是完整 G1 阻断：311/311 `INode` 节点可实例化且 name 唯一，但 311/311 节点和 114/114 credential 类含英文；6,517 个可见 metadata occurrence 中 6,417 个为英文，且 71 个节点存在 91 个未在本审计调用的 dynamic `loadMethods`。
-   独立安全扫描确认当前树与本候选已知 token 格式命中为 `0`；同时发现早期上游版本标签可达的 2023 年历史提交含疑似真实 Provider 凭据。本批未打印或调用该值、未调用 Provider、未改写历史；待凭据所有者提供吊销／轮换和账单核查回执。
-   本批边界：`production_write=false`、`provider_call=false`、`production_secrets_read=false`、`push=false`、`merge=false`、`image_build=false`、`deploy=false`。未完成动态 metadata 中文化、Firefox／10 主页面验收、远端 CI、不可变镜像、历史凭据吊销回执前，完整 G1 与 production promotion 均为 NO-GO。

# 2026-08-01 G1-E 动态 metadata 中文展示候选闭环

-   在同一独立 worktree 和分支上完成 fail-closed 展示投影：API 仅追加递归 `display*` 字段，`NodesPool`、原始 `name/type/category/default/loadMethod`、选项值和凭据类型均不变；UI 初始化、拖拽、导出、保存和 SDK `getFlowData` 会递归剥离展示字段。
-   确定性 catalog 当前覆盖 15 个 Agentflow V2 节点的 910 条唯一文案、114 个凭据类的 487 条唯一文案、26 个类别和 20 个动态方法策略；validator 同时确认节点／凭据构造失败均为 0、Agentflow 相同 tuple 重复 19 条且无冲突、凭据重复 0。
-   PC 展示链已接入 Add Nodes、V2/SDK 画布、NodeInfo、NodeInput/Output、凭据列表与编辑、异步下拉、Marketplace 以及文档库/RAG 配置；中英文搜索命中同一原始对象，分组、黑名单、连接和提交继续使用原始字段。
-   对抗性复核补齐根节点 `displayHint`、10 个公开 `onFlowChange` 出口、`onFlowGenerated`、SDK `getFlowData`、`flowExport` 与复数 `outputs`。数组形态 `outputs` 按元数据递归投影并在持久化前清洗；对象形态 `outputs` 作为运行时业务数据保持逐字段等值，避免误删合法输出。
-   最终复审关闭共享组件漏链：主 UI 与独立 Agentflow SDK 的静态／多选下拉均以模块私有 `WeakMap` 保留英文原文供检索，不增加可枚举或 JSON 字段，中文／英文／机器名均可搜索且提交值不变；两套 Agentflow V2 的预览边和已保存边仅在渲染层把 `proceed/Proceed/reject/Reject` 映射为“继续／拒绝”，`Canvas`、handle 与 `data.edgeLabel` 保持原值；损坏的多选 JSON 静默回退，不输出原始数据。
-   当前稳定树回归通过：server metadata localization 4 suites／18 tests；UI 完整 Jest 20 suites／253 tests；Agentflow 完整 Jest 77 suites／1308 tests；隔离 E2E runner contract 13 suites／24 tests；静态安全 341／341；metadata validator 为 pass；135 个变更代码路径 ESLint 为 0 error，139 个支持格式路径 Prettier check 与 `git diff --check` 通过；UI/server/Agentflow production build 均为 exit 0，Agentflow build 转换 7218 modules。
-   首轮隔离 Chrome 暴露 V2 画布仍调用 ReactFlow 弃用 `project` 的 console warning；已将主 UI 与独立 Agentflow 拖放路径迁移到 `screenToFlowPosition` 并补回归。最终稳定树隔离 Chrome 150／Node 24.18.0 run `9c162481-120b-49fc-9b19-b8941aa1ab45` 为 1 spec／3 tests 全绿，console error/warning 为 0，并验证节点／凭据 API、根节点 hint、复数 outputs、画布中英文搜索、拖拽载荷、保存请求、SQLite 回读和重载；首次文档请求强制 200，缓存重载允许 200/304，runner 最终 `phase=cleanup status=complete`，临时目录、监听端口与对应进程均不存在。
-   精确 136 路径候选以二进制 diff SHA-256 `51c4b578006a2e0930e40a5ac41f6cb26ecf89c9138a34e31208cd3354c2a43e` 完成双重复核并原子提交为 `0388dad97ac41f2f101864503906fe7bb04450bf`；提交后从 `HEAD^..HEAD` 重算路径数和哈希均完全一致。独立代码审查为 0 个问题；安全审查为 CRITICAL/HIGH/MEDIUM `0/0/0`、LOW `1`，唯一 LOW 是 runner 当前只精确拦截外部 HTTP(S)、尚未把 `ws:`/`wss:` 纳入“全协议断网”保证，不阻断本次仅使用合成数据且未使用 WebSocket 的隔离候选。
-   G1-E 本地候选判定为 `GO`；该结论只覆盖上述精确提交，不等同于远端 CI、镜像、生产部署或历史安全事件关账。首次提交尝试因 shell 使用 Node 22 被 engine 门禁拒绝，切换到仓库要求的 Node 24.18.0 后预提交格式化与 ESLint 门禁通过并完成提交。
-   当前仍有 296 个非 Agentflow 节点和 71 个动态方法未进入中文 catalog；该候选只关闭 G1-E，不等于完整全中文。历史 Provider 凭据仍缺 owner/provider 侧吊销／轮换、使用与账单、暴露面回执，production promotion 继续 NO-GO。
-   本批边界保持：`production_write=false`、`provider_call=false`、`production_secrets_read=false`、`push=false`、`merge=false`、`image_build=false`、`deploy=false`；浏览器截图随隔离临时目录清理，不作为 Playbook 正式截图。

# 2026-08-02 G1-F 全量 metadata 与 PC 浏览器候选闭环

-   全量确定性中文 catalog 已覆盖 311/311 节点与 114/114 凭据：节点 metadata 6,210 条、exact 914 条、context override 4 条、source translation 2,884 条、primitive value-option 48 条；Agentflow 910 条、凭据 487 条。91 个动态方法全部分流为 system 51、tenant passthrough 24、provider passthrough 16，unknown 为 0，动态描述 137 条。
-   validator 绑定源文件摘要、基线计数与摘要、import identity、Map composition、TypeScript 语法、catalog collision、覆盖率和新鲜 build receipt；当前 receipt 绑定 576 个输入文件，source SHA-256 为 `bede9a5400cd76df16c7fc2cabe17cb291818601ce076d247df0afbba5525381`。等量策略交换、漏 spread、Map 改 Set、错误 import alias、语法错误、collision、基线漂移及 receipt 缺失／过期均已在临时副本中验证 fail closed。
-   最终复审发现主 Canvas 与 UI Agentflow V2 的 Sticky Note 是绕过通用 `NodeInputHandler` 的特殊渲染器；现统一从当前 component registry 生成 render-only input view，中文占位符只进入渲染，机器键、默认值、用户值和保存 schema 继续使用 raw input。旧流程伪造的 `displayPlaceholder` 会被剥离，registry 缺失时回退原始英文；legacy `reactFlowInstance` 未解构问题同步修复。
-   最终本地自动化：UI 21 suites／267 tests；便签与 metadata 定向 UI 32/32、server 17/17、Agentflow 28/28、runner 26/26；metadata fingerprint 2/2；静态安全 341/341；release Node 76/76 ＋ Python 138/138；全量 ESLint exit 0（0 error、8 个既有 warning）；UI production build 21,205 modules，通过。既有 Agentflow/server/components 全量构建与相关全套测试证据保持通过。
-   聚焦 Chatflow Chrome run `21ba67cd-84ec-45ac-89a1-0711f9493c2c` 为 1/1，通过中文便签、保存、重开、复制与删除，并由 API/SQLite 断言保存态仍为英文 raw placeholder 且不存在 `displayPlaceholder`；cleanup complete。
-   完整隔离 Chrome run `23068177-1b5b-47da-b00e-596797d96683` 在 Chrome 150／Node 24.18.0 上完成 5 specs、7/7 tests、43 秒、exit 0：API Key、Variable、Chatflow、PC core 和 10 个生产主模块壳层全部通过，最终 `phase=cleanup status=complete`。运行截图随临时目录清理，仅保留 run ID 与终端回执，不冒充 Playbook 正式截图。
-   代码审查对 exact 45-path 候选报告所有 severity 0；安全审查报告候选 Critical/High/Medium 0、LOW 1。唯一 LOW 是 runner 只能证明外部 HTTP(S)／WS(S) 隔离，不能宣称 OS 级全协议隔离，不阻断本次 approved synthetic specs。
-   候选二进制 diff SHA-256 `fafdeef3f5e64b3b0fd2173ac8945e7dce721fc94744529c44dcb5abf11ff5b5`，unstaged/unmerged 均为 0；原子提交 `0f6354aeba2578be7f1bf0a8158988cbbfe4488c` 后从 `HEAD^..HEAD` 复算仍为 45 paths 和同一哈希。
-   本地 G1-F candidate 判定为 GO；production promotion 继续 NO-GO。未完成项为 Firefox、exact commit 的 push/远端 CI、不可变 `linux/amd64` image 与 registry 证据、历史 Provider 凭据撤销／轮换及账单／制品清除回执、备份／回滚、生产 cutover 与部署后双浏览器验收。
-   本批边界：`production_write=false`、`provider_call=false`、`production_secrets_read=false`、`push=false`、`merge=false`、`image_build=false`、`registry_write=false`、`deploy=false`；原 dirty checkout `/Users/pray/project/FlowAgentic/flowise` 未修改。

# 2026-08-02 G1-G 远端 CI、隔离镜像与双浏览器闭环

-   Draft PR `#14` 的可执行代码候选为 `41e63ed3e8cdb41b9a272f1d26bc2ac9211bb2d3`，base 为 `70d8040e5ead30a7a51e2231a6a156d5632e6e25`；该代码 SHA、远端分支和 PR head 在状态同步前一致。
-   Node CI `30734841675` 为 success：Linux Chrome 5 specs／7 tests 全绿，冻结安装、release/security、lint、build、metadata、覆盖率和中文门禁均通过。Docker CI `30734841661` 为 success：原生 `linux/amd64` build 与 canonical offline artifact／isolated runtime 验证通过；PR 条件下没有上传 registry 制品，`release_readiness` 也未运行。
-   当前代码候选的本地 Chrome run `2c88108d-7eb5-4a9e-a537-229bf02a966e` 与 Firefox ESR 140.13 run `64481524-a7a4-43c7-80ce-d6a3e8e541d2` 均为 5 specs／7 tests，清理完成且临时数据库、密钥、端口及对应进程残留为 0。
-   GCM 增量代码／安全复审无 MEDIUM+；两项 LOW 均为测试强化建议，不阻断 Ready。正式 Codex branch helper 在约 8 分 43 秒后仍无最终输出，已终止进程树；actionable finding 为 0，但该结果不得表述为 helper clean 或 APPROVE。
-   PR 平台当前无 branch protection 或 ruleset，review、review request、review thread 均为 0；CodeRabbit 状态实际为 Draft skipped。门禁允许进入 Ready 以触发实质审查，但不允许 merge、发布或部署。
-   production promotion 继续 NO-GO：历史 Provider 凭据关账 7 项仍未关闭；缺少 current main readiness 的持久化自绑定制品、备份 checksum／恢复演练、生产 secret/key continuity、cutover 与部署后双浏览器验收。
-   本批边界：`provider_call=false`、`production_secrets_read=false`、`production_write=false`、`registry_write=false`、`merge=false`、`deploy=false`。

# 2026-08-03 G1-H 对抗性加固候选检查点

-   PR `#14` 在本地加固批次开始前为 `OPEN/Ready`，head 为 `48573043d5340c61c49553e97deff7141be577d5`；当前本地分支 HEAD 仍为该提交，新增实现尚未提交。
-   状态文档同步前的 dirty 快照为 109 个 tracked changed paths（108 modified、1 deleted）、110 个 untracked paths、staged `0`，tracked diff 为 10,133 additions／4,805 deletions；该计数只绑定同步前时间点，最终身份以临时 index 冻结结果为准。
-   本批实现覆盖 workspace／capability scoping、DocumentStore integer revision CAS 与 SQLite／PostgreSQL／MySQL／MariaDB 迁移、HTTP／OpenAI／MCP 资源有界生命周期、删除／计量修正，以及权限、确认、资源状态和画布保存等 UI 合同。
-   独立审查先后识别并关闭：OpenAI 流式超时早退不可逆存储／记账、累计下载剩余额度、MCP cache close liveness、Axios transformRequest 重放计数、transformResponse 前原始字节计数、空状态底层流清理、UTF-16LE 解码后欠计及 lifecycle 初始化 listener 泄漏。最终 HTTP 与 OpenAI／MCP 定向终审均无剩余 MEDIUM+。
-   稳定实现树自动化：components focused `227/227`、full `37/37` suites／`1314/1314` tests；server full `133/133` suites／`1815/1815` tests；components/server TypeScript 与 production build 通过；security `341/341`；release Node `77/77` ＋ Python `138/138`；metadata 311 节点、91 动态方法 unknown `0`；E2E runner `26/26`；production audit 为 high/critical `0`、moderate `64`、low `25`；全仓 lint `0` error、8 个既有 warning，变更文件 Prettier 与 `git diff --check` 通过。
-   UI full Jest `45/45` suites／`574/574` tests 与 production build 已在本批 UI 稳定树通过；后续 HTTP-only 修复未修改 UI。隔离 Chrome 150 run `12566cdb-9c75-4cc1-8a87-b8d216318e4d` 与 Firefox ESR 140.13 run `2aa7c1bf-d888-4e6d-9d85-4a41abb75cd7` 均完成 5 specs／7 tests，runner cleanup 为 complete；首次用浏览器别名的 Firefox 发现失败也完成安全清理，不计为产品失败。最终候选哈希、原子提交、push 与新 exact-head CI 仍待完成。
-   边界保持：`provider_call=false`、`production_secrets_read=false`、`production_write=false`、`registry_write=false`、`merge=false`、`deploy=false`；production promotion 继续 NO-GO。

# 2026-08-03 G1-J DocumentStore 一致性与租户边界检查点

-   当前分支仍为 `codex/flowise-g1-zh-20260801`，提交基线仍为 `48573043d5340c61c49553e97deff7141be577d5`；G1-H／G1-J 变更和本节文档尚未提交，真实 staged 为空，最终候选身份待临时 index 冻结。
-   本批关闭 DocumentStore HMAC 代际指纹、Web／Worker 密钥初始化顺序、Loader／Vector 运行时租户边界、Chatflow 全量 Store 引用校验、完整 `whereUsed` 集合同步、通用字段越权、物化 `STALE` 失效及 Provider 元数据 getter／宽度攻击面。多 Store 定向回归为 2 suites／57 tests。
-   全量自动化：server `140/140` suites／`1922/1922` tests，components `39/39` suites／`1328/1328` tests，UI `47/47` suites／`607/607` tests；components/server TypeScript 和 build、UI production build 21,212 modules、security `341/341`、release Node `77/77` ＋ Python `138/138`、E2E runner `26/26`、metadata validator（311 nodes／91 dynamic methods／unknown 0）均通过。
-   `pnpm audit --prod --audit-level high` 为 high/critical `0`、moderate `64`、low `25`。同日全依赖在线审计因 registry 新增 advisory 报告 2 critical／24 high，均位于开发／构建依赖路径；该事实记录为独立工具链维护项，不扩大或误写为生产依赖门禁失败。
-   全仓 lint exit `0`（0 error、8 个既有 warning），候选文件 Prettier 与 `git diff --check` 通过。隔离 Chrome 150 终态 run `7701fb94-dc3e-41be-b7f3-f9e7d5261959`、Firefox ESR 140.13 run `b79ecde7-cc97-4135-806d-5724391d59f8` 均为 5 specs／7 tests 和 cleanup complete。
-   Chrome 首轮 run `98f9fbd3-a8e0-4d71-a7f0-e21082272dd4` 功能 7/7 后在 5 秒观察窗内报告 `cypress-process` cleanup failure；runner 正确 exit 1，事后临时目录、浏览器、Cypress、服务与端口残留为 0，同内容完整复跑未复现。该轮不计作通过证据，也不以无持续残留掩盖 fail-closed 事实。
-   后续对抗批次关闭工作区导入 mass assignment／关系污染／资源预算、可恢复导出误含旧版 Assistant、Custom Assistant 与 DocumentStore 使用索引跨事务、ChatMessage／Execution 关系污染、Evaluation 批删越界、CustomTool workspace 越权、Chatflow 跨类型 BOLA／RBAC、MCP 配置泄漏与并发覆盖，以及认证 secret 文件竞争／symlink 和全局错误泄漏。
-   最新稳定源代码树全量自动化为 server `153/153` suites／`2102/2102` tests、components `40/40` suites／`1338/1338` tests、UI `47/47` suites／`607/607` tests；server／components／UI production build、候选 ESLint／Prettier／diff-check、security `341/341`、release Node `77/77` ＋ Python `138/138`、metadata 311 nodes／91 dynamic methods unknown `0`、E2E runner `26/26` 均通过。生产依赖审计为 high/critical `0`、moderate `64`、low `25`。
-   最新隔离浏览器证据：Chrome 150 run `1e4a257f-6fa3-47bb-991c-5f63c6b6ffc4` 与 Firefox ESR 140.13 run `8382b941-e56c-4fe2-9299-1989e60196e6` 均为 5 specs／7 tests、cleanup complete。Firefox DMG 对照 Mozilla 官方 SHA-512 清单，SHA-256 为 `0a7c51def21ab65d295d839c270405d0a2c2a04d589e8ce92c5e238eeb3f1827`，Apple 签名与 notarization 通过；临时 DMG／挂载／浏览器／runner／端口／目录残留为 0。
-   生产阻断保持：durable provider/storage cleanup outbox、S3 partial delete reconciliation、Provider 成功／CAS 前故障恢复账本、workspace tombstone/outbox、Chatflow／DocumentStore 跨 aggregate 原子性，以及历史 Provider 凭据关账、main readiness、备份恢复、生产密钥连续性和 cutover。`provider_call=false`、`production_secrets_read=false`、`production_write=false`、`registry_write=false`、`merge=false`、`deploy=false`。

# 2026-08-03 G1-K 工作区可移植性与 MCP 检查点

-   当前本地 HEAD 仍为 `48573043d5340c61c49553e97deff7141be577d5`，真实 staged 为空；本节实现、测试和 Runbook 均属于未提交 mutable tree，旧 exact candidate／CI／浏览器结果不覆盖它。
-   导入新增 pre-normalization rebinding scrub：不信任 manifest，按本地 component catalog 清洗 Flow、wrapper、Assistant 和 DocumentStore，变量值置空；关系预检只接受导入包内 Flow／Tool／Store／Execution／Message，数据库既有 UUID 不再作为合法依赖。
-   导出新增 feedback tuple 精确取父消息、Execution ID ＋ workspace 精确取父执行和 10,000 行有界批次；行为回归证明即使全消息扫描会因超过 10,000 条失败，一条 feedback 的 record-closure 仍能成功构建。
-   Meilisearch `BaseRetriever` 与 Vector Store provider 列表对齐；LlamaIndex 和内部 store 仍拒绝。Header 清洗从宽泛 suffix 改为精确危险输入名，保留 Google Sheets `includeHeaders` 与 Markdown splitter `splitByHeaders`。
-   MCP 旧明文 Token 现在迁移为 disabled 且删除 bearer material；公开 endpoint 拒绝明文，Token 签发响应 no-store，描述 4,096 字符上限，MCP JSON parser 位于鉴权／限流之后。该行为会使旧客户端中断，必须在受控发布窗口由管理员重新启用并分发新 Token。
-   组件 metadata 的 `workspaceExportPolicy: rebind` 现在覆盖本地文件／目录、数据库 URL、TLS 文件、TypeORM `additionalConfig` 和 Flow／Tool 任意 override；8 个 `loadConfig: true` 动态子配置递归清洗，受信端点／主机保留并要求复核。
-   MCP endpoint 在整个 `/api/v1/mcp` 命名空间、canonical casing guard 和 parser 前建立一次性 finish／close 观察器；无 ID、混合大小写、401、404、429、413 等终态进入 allowlist 审计与 Prometheus／OpenTelemetry。audit 仅含随机 requestId、方法、固定 route、statusCode、durationMs 与 completion，不记录 chatflowId、Header、query、body、Token 或原始路径。
-   首轮专项发现并修复 Assistant tool wrapper 外层 credential 残留、DocumentStore optional config 被写成 `undefined`、header suffix 误删、MCP 测试 mock 缺返回值、动态子配置孤儿和静态中间件顺序断言。首个 338-path temp-index freeze（patch SHA-256 `640cfe257af0ef5b6e30ff50baf027e277c4a756249b0ff6f2806624fd803cb8`）在复审发现问题后已明确作废，不能作为提交身份。
-   冻结后复审发现并关闭 3 个 MEDIUM：旧版 OpenAI Assistant／Vector Store Provider 读取缺少 `credentials:view`、未知 MCP method／subpath 会落入全局 50 MiB parser、无 ID MCP root／trailing-slash 未进入观察器；同时关闭 audit 高基数 chatflowId 和 Provider 畸形分页误报空文件集 2 个 LOW。更新后聚焦 `6/6` suites／`77/77` tests、目标 ESLint、server TypeScript／build 及独立复核均通过，当前所有级别 finding 均为 0。
-   更新后稳定树通过 server `162/162` suites／`2219/2219` tests、components `41/41` suites／`1339/1339` tests、UI `50/50` suites／`622/622` tests；server production build、release Node `77/77` ＋ Python `138/138`、security `341/341`、聚焦 ESLint 和独立复核均通过；根构建为 6/6 workspace，metadata 为 311 nodes／91 dynamic methods、unknown 0。最终 freeze、全局 lint／format／diff-check、冻结双审、提交与 push 仍待本门禁回执。
-   隔离 Chrome 150 run `100b0677-1b71-44d1-aeb4-0f2ceeda475e` 与 Firefox ESR 140.13 run `fd0f645a-a91d-471f-b10d-809fc1580d3b` 均完成 5 specs／7 tests。Firefox 包对照 Mozilla 官方 SHA-512，SHA-256 为 `0a7c51def21ab65d295d839c270405d0a2c2a04d589e8ce92c5e238eeb3f1827`，Apple 签名与 notarization 通过；runner、挂载、浏览器、进程和临时目录清理完成。
-   Firefox 首次编排在浏览器启动前因 shell 回落 Node 22 被 pnpm engine 门禁拒绝；切换项目锁定的 Node 24.18.0 后完整通过。该失败不计为产品失败，也没有被通过结果掩盖。
-   新的 temp-index freeze、冻结后代码／安全双审、哈希复算、原子提交与 push 尚未完成，因此未提交、未 push、未 merge、未部署；`provider_call=false`、`production_secrets_read=false`、`production_write=false`、`registry_write=false`。
