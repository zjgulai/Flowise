---
title: Flowise 审计整改发现记录
date: 2026-07-10
last_updated: 2026-07-12
---

# 当前证据矩阵

| 问题                       | 当前状态                        | 最高证据等级 | 说明                                                                                                                                          |
| -------------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 公网 `3000`                | 已闭环并刷新                    | L4/L3        | July 10 已授权修复后，July 12 read-only L3 再次确认公网 HTTP `000`、TCP refused；容器仅绑定私有代理 gateway `172.20.0.1:3000`。               |
| Node 20/24 不一致          | 已上线修复并刷新                | L4/L3        | 生产容器运行 Node `v24.18.0`；July 12 image ID 仍为 `sha256:3c66e08b...fad9`。                                                                |
| `/register` 死交互         | 已上线修复                      | L4           | 已初始化 open-source 实例访问 `/register` 自动跳转 `/signin`。                                                                                |
| `GET /auth/resolve` 500    | 已上线修复                      | L4           | GET 返回受控 405，body 无内部字段；POST 保持 `/signin` 合约。                                                                                 |
| Google Fonts/Rewardful CSP | 已上线修复                      | L4           | 生产浏览器 console 无相关 error/warning。                                                                                                     |
| 非法 UUID/CORS 日志噪音    | 已上线、部分验收                | L4/L2        | 本地 34 项 XSS/CORS 测试通过；生产非法 Origin preflight 无 ACAO，近期错误日志为 0。                                                           |
| AppleDouble 镜像污染       | 已上线修复                      | L4           | 本地和远端镜像扫描均无 `._*`，生产日志匹配为 0。                                                                                              |
| 安全头职责重复             | 已上线修复并刷新                | L4/L3        | Nginx 负责 HSTS/XFO/XCTO/Referrer，app 负责 CSP；July 12 edge smoke `14/14`，公网每项各 1 个。                                                |
| Iframe/CSP 配置治理        | Task 5 本地完成，未部署         | L2/L3        | Commit `1372561` 的 request/CSP contract 已审阅；生产仍无 CSP Report-Only/Reporting-Endpoints，现行 CSP 仍含 `unsafe-eval`。                  |
| 登录后核心功能             | 未验收                          | L0           | 页面可打开不等于认证/session/画布/文档库可用。                                                                                                |
| 忘记密码业务结果           | 未验收                          | L1           | 页面与禁用态可见；SMTP 未配置/已配置反馈及真实测试邮件未验证。                                                                                |
| Kimi/Deepseek 定制节点     | Task 4 本地完成，未部署         | L2           | Commit `b73a3c8` 的 Provider tests `225/225`、build、compiled-load smoke 全绿；`provider_call=false`。                                        |
| Release provenance         | source/config 完成，Docker 阻塞 | L2           | Commit `699b59b`：release tests `18/18`、static gate `95/95`、clean-clone frozen install 通过；没有 candidate image/archive/actual manifest。 |
| i18n/upstream 维护         | 未完成                          | L1           | 大量 hard-coded 中文 diff，缺稳定适配策略。                                                                                                   |
| About 版本外联             | 未处理                          | L1           | GitHub latest release 请求的禁用、缓存或自托管策略尚未确定。                                                                                  |
| `/signin` 初始化异常       | 已上线修复                      | L4           | 生产 browser console 与容器日志均无 TypeError。                                                                                               |
| 认证页移动布局             | 已上线修复                      | L4           | `390x844` 下 `clientWidth=scrollWidth=390`，所有关键控件在视口内。                                                                            |

# 已确认工程事实

-   实际 git root 是 `/Users/pray/project/FlowAgentic/flowise`；当前分支 `codex/flowise-release-foundation-20260712`，base `bb773ffa710bd22639c4ba2643413a0ea2b679d3`，Task 1-6 source/config HEAD `699b59b1c08413e0785a9732c2dfe4c020b4a331`。
-   工作区存在大量非本轮产生的修改与未跟踪文件，禁止使用 `git add .` 或全仓格式化。
-   既有生产构建失败点是远端 Alpine `apk add` 长时间停滞；旧镜像与新 compose/env 组合曾导致 `502` 和 auth secret 初始化错误，已回滚。
-   生产端口的 firewall 修复与镜像/compose 修复是不同层级：前者是当前缓解，后者才是根因闭环。
-   新镜像必须把 image、compose、env 视为同一运行时合约，不得混搭未经兼容性验证的版本。

## 2026-07-12 当前快照

-   Task 1-6 共 12 commits、212 paths。Task 7 编辑前快照为 `tracked_changed_paths=2`、`untracked_paths_all=32`、`cached_paths=0`；这是带明确口径的时间点，不是持续不变的指标。
-   Public L3 `2026-07-12T10:48:40Z`：edge smoke `14/14`；HTTPS ping `200 pong`、signin `200`、auth GET `405` 且无内部标记、auth POST `200` 指向 `/signin`、恶意 Origin 无 ACAO；公网 `3000` HTTP `000`、TCP refused。
-   SSH L3 `2026-07-12T10:51:01Z`：Flowise running/healthy、restart `0`、Node `v24.18.0`、`linux/amd64`；仅绑定 `172.20.0.1:3000`。生产仍使用 July 10 image `sha256:3c66e08b50562ab856328d669b611d000ccee6c9467f1560b7b8b4ba0b86fad9`，其 RepoDigests 与 OCI source/revision/version/created/ref labels 均为空。
-   生产 Compose image reference 仍为 legacy `flowise-chinese:latest`；这是观测事实，不是未来发布合同。Task 6 已要求 Git-derived immutable image reference，但其 Docker build 在 Dockerfile evaluation 前被 registry metadata `EOF` 阻塞。
-   `backup_state=exists_not_checksum_or_restore_verified`。
-   Task 4/5/6 均未由本轮部署：`production unchanged`、`production_write=false`、`provider_call=false`、`secrets_read=false`。

# 2026-07-10 历史刷新已完成

-   已采集生产认证入口、console、桌面/移动截图与布局指标。
-   已采集生产 API、端口、Node、container、network 和日志的 L4 状态。
-   已完成本机 `linux/amd64` clean builder、runtime image 与远端加载验证。
-   已记录构建失败根因、成功制品 SHA256、生产 image ID、备份和 rollback tag。

# 2026-07-10 首次审计基线（已被后续 L4 证据取代）

-   L3 HTTPS health：`/api/v1/ping` 返回 `pong`。
-   L3 auth contract：`GET /api/v1/auth/resolve` 仍为 `500`，body 暴露 `isOrganizationAdmin`；`POST` 为 `200` 并返回 `/signin`。
-   L3 端口：外部访问 IP `:3000` 超时（curl exit 28），但 Docker 仍发布 IPv4/IPv6 `0.0.0.0:3000`；防火墙服务 enabled/active，`DOCKER-USER` deny 规则存在。
-   L3 runtime：`flowise-chinese` healthy，image ID 为 `sha256:2f9b...f3d8`（缩写记录），Node 为 `v20.20.2`。
-   L3 日志：最近 30 分钟未匹配 Node engine、Permission denied、auth secret initialization 三类错误；这不证明旧镜像历史噪音已消失。
-   L2 本地静态安全检查：14 passed、0 failed、0 warnings；`git diff --check` 通过。
-   本机 Docker/BuildKit 正常，支持 `linux/amd64`；当前 images 约 13.96GB、volumes 约 72.42GB、build cache 约 843.6MB，可执行独立构建但需关注剩余磁盘。
-   Product Design saved context 不存在，本轮直接以用户给定生产 URL、仓库设计系统与当前截图为依据。

# 当前未登录产品流

-   `/signin`：桌面和 390px 表单均包含邮箱、密码、显示密码、忘记密码和登录按钮；无横向溢出，console 无 error/warning。
-   `/register`：生产自动跳转 `/signin`，不再显示无效创建账户表单。
-   `/forgot-password`：页面可渲染，空邮箱时发送按钮 disabled；SMTP/真实发送未测试。
-   当前上线截图与 Playwright snapshot 保存在 `output/playwright/production-node24-20260710/.playwright-cli/`；登录桌面、登录移动和忘记密码移动截图均已人工检查。

# 新发现根因

-   `/signin` TypeError 的源码根因已确认：中文化把 `ssoApi.ssoLogin` 改成不存在的 `ssoApi.sso登录`，把 `loginMethodApi.getDefaultLoginMethods` 改成不存在的 `loginMethodApi.getDefault登录Methods`。`useApi` 接收 `undefined`，配置加载初期调用 `request()` 后执行 `apiFunc(...args)`，产生 `TypeError: e is not a function`。
-   同文件还把 `ssoLoginApi`、`doLogin` 和 icon import 标识符改成中文混合标识符。它们语法合法但扩大 upstream merge 和静态审查风险；可执行标识符应恢复英文，仅翻译展示字符串。
-   移动裁切由源码 `width: '480px'` 直接解释。浏览器实测 `390px` 视口下 register form parent 为 `x=-45, width=480, right=435`，页面没有水平滚动区，左右各 45px 被裁切。
-   注册页截图两侧黑色与 computed body background `rgb(250, 248, 245)` 冲突，判定为当前截图后端的未绘制区域表现，不作为产品背景色缺陷。
-   GitNexus MCP 未在本会话暴露；CLI `npx --no-install gitnexus status` 未返回可用结果，因此根因最终以生产 stack、源码 diff、API export 和浏览器布局 metrics 四层证据确认。

# 本地认证入口修复证据

-   `scripts/verify-security.sh` 新增 4 个 contract：两个 sign-in API export binding、认证页禁止固定 480px、AuthLayout 响应式最大宽度。
-   新门禁在改代码前稳定得到 `14 passed, 4 failed`；修复后为 `18 passed, 0 failed, 0 warnings`。
-   `signIn.jsx` 已恢复英文 API/handler/icon 标识符，并保持中文展示文案。
-   `AuthLayout` 改为 box-sizing 内的 `width: 100%`、`minHeight: 100vh`、水平 padding，并限制直接子页面最大 512px。
-   sign-in、register、forgot/reset password、verify/confirm email、organization setup 的表单容器均改为 `width: 100%; maxWidth: 480px`。
-   organization setup 内被翻译的 schema/state 标识符已恢复为 `confirmPassword`、`setEmail`、`setPassword`，展示文案不变。
-   UI Jest：2 suites、65 tests 全部通过。
-   Vite production build 通过，21176 modules transformed；仍有既有 dynamic/static import 冲突和大 chunk 警告，主 bundle 约 5.74MB，归入 Batch 7 性能债。

# 下一批执行决策

-   Node 24、未登录认证入口、auth method boundary、私有端口绑定和镜像污染问题已完成 L4 闭环。
-   Batch 4 登录后核心 E2E 仍是最高产品风险，但受专用测试账号、隔离 workspace 和安全凭证交付路径阻塞。
-   Task 4 已把 Batch 5A 收敛成独立 commit：DeepSeek/Kimi fail-closed transport、credential schema、错误脱敏、取消/超时和 SSRF 边界均有自动化证据；真实 provider call 继续禁用。
-   Batch 6A header owner 的 July 10 L4 保持有效；Task 5 已把 Batch 6B 收敛成独立 commit。生产仍维持 `compat` CSP 且未开启 report-only，部署与 enforcement 提升需单独授权。
-   Stage 0 Task 1-8 已完成本地 source/config/review 闭环；实际 Docker image/archive manifest 尚未生成。下一步是 registry 可用后的本地 artifact completion，不是直接部署。
-   Batch 7 处理约 3.57 GB runtime image、5.74 MB 主 bundle、runtime 编译工具链和 upstream/i18n 维护债。

# 2026-07-12 Task 4 Provider Source Contract

-   Commit `b73a3c89586de994bc840cfb8dff50a27d81c057` 已通过独立复审；Provider tests `225/225`、TypeScript、focused lint、components build、static security `52/52` 与 compiled-load smoke 均通过。
-   当前 contract 不暴露 thinking/reasoning controls 或 thinking-only model；旧配置若请求不支持的 reasoning 能力会在读取 credential 和发请求前失败。Kimi K2.5/K2.6 使用明确 disabled-thinking 参数，K2.7 不进入目录。
-   所有验证均为本地 fixture/metadata：`provider_call=false`、`secrets_read=false`、`production_write=false`。Stage 0 没有把该 commit 部署到生产。

# 2026-07-10 Batch 5A 历史 L2（已由 Task 4 取代）

-   DeepSeek 节点原实现只传 `openAIApiKey`，而当前 `@langchain/deepseek@1.0.9` 实际读取 `apiKey`；已显式传递并用初始化测试覆盖。
-   Kimi credential 原为 optional，存在回退到进程 `OPENAI_API_KEY` 后把错误 credential 发往 Kimi endpoint 的风险；现已改为 required 并在创建 SDK client 前拒绝空值。
-   两个节点原先允许任意 Base Path 且直接使用 SDK fetch，存在 credential 被自定义 endpoint 或 redirect 带走的风险；现只允许官方/显式 allowlist HTTPS origin，并统一经过 redirect-aware `secureFetch`。
-   `Base Options` 现在只接受受保护 header 校验的 JSON object；Authorization/Host/Proxy/X-Forwarded/Sec 与控制字符注入由既有 header validator 拒绝。
-   数值输入不再把空值或尾随字符解析为 `NaN`/部分数字；timeout 使用毫秒单位。
-   OpenAI SDK 虽固定 `maxRetries=0`，LangChain 外层 `AsyncCaller` 默认仍重试 6 次；已在两个节点显式设置 LangChain `maxRetries=0`，避免超时被指数退避放大。
-   DeepSeek 默认升级为 `deepseek-v4-flash`；目录加入 V4 Flash/Pro，旧 aliases 保留并标注 2026-07-24 Legacy。
-   Kimi 默认升级为 `kimi-k2.6`；目录加入 K2.5/K2.6/K2.7，同时在初始化阶段拒绝 K2.7 关闭 thinking，以及 K2.7/K2.6/K2.5 不支持的 temperature/top_p/penalty 组合。
-   L2 证据：provider 定向 69/69；既有 HTTP/header 81/81；完整 components 24 suites/943 tests；TypeScript、focused lint、components build、静态门禁 37/37、Compose template parse、`git diff --check` 全部通过。
-   compiled-load smoke 仅加载构建产物并读取 metadata，确认两个 credential required、官方 Base Path 和新默认模型；未调用 `init`/`invoke`/`stream`/provider model list。
-   compiled-load smoke 首次发现 DeepSeek timeout 说明被误放在 Max Tokens；新增 metadata RED 后移动到正确字段，最终 smoke 确认 timeout 单位说明与 Max Tokens 均符合契约。
-   未完成：真实 provider sandbox smoke、认证后的节点 UI 截图、K2.7 `tool_choice` 独立约束、`reasoning_content` UI/持久化链路和统一成本 schema。
-   边界：`provider_call=false`、`secrets_read=false`、`production_write=false`，生产环境未改变。

# 2026-07-12 本地发布与镜像契约

-   `Dockerfile` builder/runtime 均 pin `node:24.18.0-alpine` 与 registry index digest；repo toolchain 为 Node `24.18.0`、pnpm `10.26.0`，依赖安装保持严格 `pnpm install --frozen-lockfile`。
-   Compose 没有 build fallback，要求 Git-derived `FLOWISE_IMAGE` 和显式 `POSTGRES_IMAGE`；`latest` 与非唯一 app tag 由 preflight 拒绝。生产观测到的 legacy `flowise-chinese:latest` 不满足未来发布合同。
-   Release manifest v1 分离 Git source、image config digest、archive SHA-256/bytes 和 platform；RepoDigest 不得由这些字段推断。Task 6 只完成 source/config 验证，实际 archive manifest 未生成。
-   `.dockerignore` 已排除 `.env*`、常见 key/pem、嵌套 `node_modules/dist/build` 和 macOS metadata，避免将敏感文件或 AppleDouble 带入镜像。
-   runtime 阶段仍安装 `make`、`g++`、`build-base`、`cairo-dev`、`pango-dev` 和 `git`，与“仅运行时依赖”注释不一致。它不是当前上线阻断项，但属于镜像体积与攻击面债务，已加入 Batch 7。

# 2026-07-12 Task 8 Final Review Findings

-   原 release source gate 只检查少量生成目录与 SSH key，Git-ignored 的 uploads、`api.json`、cert/key variants、`extensions/`、private apps 和本地 agent 文件仍可被 `COPY . .` 带入镜像而不进入 clean manifest。现已镜像当前 ignore contract、加入 ignored/allow probes、数组长度 fail-fast，并检查本 checkout 实际 ignored paths；真实 Docker context/image 仍需 registry 恢复后的 artifact verification。
-   生产只读证据显示容器用户为 `node`、HOME 为 `/home/node`，现有 `encryption.key` 位于 `/home/node/.flowise`，而持久卷挂载到 `/usr/src/flowise/.flowise`。Compose/Dockerfile 现绑定并赋权持久路径，同时要求 `FLOWISE_SECRETKEY_OVERWRITE`；但部署前必须通过另行授权复用当前 key，不能生成替代值或只改路径后 recreate。
-   `global-agent@3` 的默认 `forceGlobalAgent=true` 会覆盖 `secureFetch` 的 DNS-pinned Agent，使请求在校验后可能再次解析 DNS。Server 现用 `bootstrap({ forceGlobalAgent: false })`，Node 24 子进程集成测试与独立真实组合验证均证明 transport 保留显式 Agent、没有 fallback lookup。
-   `.env.production.template` 原有宽泛 Tool external dependencies，但 Compose 未转发；直接补转发会首次扩大生产攻击面。模板现默认两项额外依赖为空，env preflight 强制为空，回归测试确认 `pg,puppeteer,playwright` 会 fail closed；后续开启需单独产品/安全授权。
-   单纯全文件 grep 无法证明 env key 属于 Flowise service。Static gate 现实际渲染 Compose JSON，并绑定 `services.flowise.environment`、required secret presence 和 `flowise_data -> /usr/src/flowise/.flowise`；模板值不输出，临时文件权限为 `0600` 并清理。
-   Task 8 clean-clone L2：release `19/19`、static `114/114`、components `1018/1018`、server `1004/1004`、UI `65/65`、`build:docker` `4/4`；三条独立复审 APPROVED。真实 image/archive/runtime 未验证，生产未改变。

# 2026-07-10 历史 Node 24 构建调查

# Gate B 首次构建结果

-   `linux/amd64` 构建已越过远端曾停滞的 Alpine package install 阶段，说明本地 builder 路线可行。
-   builder 在严格 `pnpm install --frozen-lockfile` 处 fail-fast：`packages/ui/package.json` 新增 `zod@^3.25.76`，但 `pnpm-lock.yaml` UI importer 未同步，报 `ERR_PNPM_OUTDATED_LOCKFILE`。
-   该失败是可复现的依赖契约问题，不允许通过恢复 install fallback 或改用 `--no-frozen-lockfile` 掩盖；修复路径是用 Node 24 / pnpm 10.26.0 只更新 lockfile，再重新运行同一构建门禁。
-   全 workspace 在线 `--lockfile-only` 产生 101 行非目标漂移（包括 `latest` 包升级和 platform metadata 改写），已从 `/tmp` 备份精确恢复，未接受该结果。
-   临时副本的 filtered offline install 因缺少直接依赖 metadata 报 `ERR_PNPM_NO_OFFLINE_META`；主仓库 lockfile 保持原状。下一步仅在临时副本测试 filtered `pnpm add` 的 diff。
-   filtered `pnpm add --lockfile-only` 仍生成约 924 MB 临时 `node_modules` 并消耗磁盘，已主动中止和删除临时目录；该命令不适合作为本仓库的 lockfile-only 修复路径。
-   当前改用与 Dockerfile 首段完全一致的 5-workspace manifest 临时副本，测试 `pnpm install --filter flowise-ui --lockfile-only`，以缩小解析面并保持主仓库零副作用。
-   5-workspace filtered install 仍产生 127 行 lockfile 漂移。关键原因是 UI 直接依赖使用 `flowise-embed: latest` / `flowise-embed-react: latest`，一旦 lockfile importer 失配，pnpm 会把锁定的 3.1.5 推进到当前 3.1.6，并重算 platform/peer metadata。
-   在接受任何 lockfile 变更前，必须确认新增 UI `zod` 是否真实需要；若需要，则应先固定 `latest` 依赖以恢复可复现性，再由 package manager 生成 lockfile。
-   UI 的注册、组织初始化和 validation 工具均直接导入 `zod/v3`，因此把 zod 作为 UI direct dependency 是正确修复；依赖 transitive hoist 不可接受。
-   已把 `flowise-embed` 与 `flowise-embed-react` 从 `latest` 固定到当前 lockfile 版本 `3.1.5`，再用 Node 24/pnpm 10.26.0 生成 lockfile。
-   生成结果未升级 embed 版本；除两个 specifier 和 zod importer 外，pnpm 规范化了已存在版本的 debug/pretty peer 绑定、deprecated 文本与 optional platform `libc` metadata。最终接受条件仍是 `linux/amd64` frozen install/build 和运行态验证通过。
-   安全/构建静态门禁新增 embed exact pin 与 UI zod direct dependency 三项检查，当前为 21 passed、0 failed、0 warnings；全仓 `git diff --check` 通过。

# Gate B 第二次构建结果

-   Docker frozen install 已通过，并明确跳过 resolution；`sqlite3` 与 `faiss-node` 均命中 `linuxmusl-x64` 预编译包，历史 native build blocker 本次未复现。
-   `pnpm build:docker` 在 UI Vite 阶段 fail-fast：`src/views/serverlogs/index.jsx` 导入 `@uiw/codemirror-theme-sublime`，但干净 workspace 中不存在该包，报 `vite:load-fallback ENOENT`。
-   本地 UI build 通过只证明开发机 hoist 提供了偶然依赖，不能替代 clean install。修复应在 UI manifest 声明 direct dependency，并由 lockfile/frozen build 验证。
-   pnpm 还报告若干 ignored build scripts（包括 swc/esbuild/sharp/canvas）；当前不先推断为故障，只有后续构建或运行验证失败时再按首个证据处理。
-   进一步核对推翻了“manifest 漏声明”假说：UI package 和 lockfile importer 均已声明 `@uiw/codemirror-theme-sublime@^4.21.21`，解析到 4.21.24。
-   新根因假说：`vite.config.js` 把 CodeMirror/UIW/Lezer 强制 alias 到仓库根 `node_modules`，而自定义 Dockerfile 依赖阶段只复制 4 个子包 manifest（总 scope 5），排除了 agentflow/observe，导致 clean install 的 root hoist layout 与完整 workspace 不一致。
-   该假说可预测：恢复完整 workspace install 后 root alias 应可解析；若仍失败，再移除/调整 alias。先对照原始/upstream Dockerfile，不同时叠加两种修复。
-   原始 Dockerfile 在 install 前复制完整源码，因此 pnpm 安装全部 `packages/*`；现有多阶段改造只复制 4 个子包 manifest，确认是相对原始构建语义的回归。
-   修复采用最小变更：依赖缓存阶段补复制 agentflow/observe manifests，恢复 7-workspace install；`build:docker` 仍排除这两个包的 build，不改变发布产物范围。
-   修复后静态门禁为 23 passed、0 failed、0 warnings，`git diff --check` 通过。
-   两次失败构建后 BuildKit cache 为 6.66 GB，其中 2.786 GB 可回收；主机数据卷约剩 9.1 GiB。第三次构建前只允许清理 reclaimable build cache，不删除 image/container/volume。
-   已执行限定范围的 BuildKit prune，回收 2.786 GB；清理后 build cache 3.874 GB、reclaimable 0，主机可用空间约 11 GiB。

# Gate B 第三次构建结果与架构审查

-   install scope 已恢复为完整 7 workspace，frozen lockfile 与 native prebuild 再次通过，但 UI build 仍无法读取 root alias；首个错误变为 root `node_modules/@uiw/react-codemirror` 不存在。
-   “缺少 workspace 导致 root hoist 不完整”假说被证伪。连续三次 clean build 已确认真正问题在 Vite 对 root-hoisted symlink 的硬依赖，而不是单个 package 声明。
-   按三次失败停止条件，不再盲改 alias。先把 Dockerfile 拆成可 target 的 deps/build stages，构建 deps diagnostic image，直接检查 root 与 UI package node_modules 的 symlink 布局。
-   导出 deps diagnostic image 使主机可用空间从约 7.9 GiB 降至约 804 MiB，触发立即停止；调试镜像已删除，可用空间恢复到约 4.4 GiB，运行容器和业务 volumes 未触碰。
-   后续诊断改为 BuildKit 内部 `deps-check` RUN 只打印 symlink，不导出完整镜像；获取证据后删除该临时 stage。
-   `deps-check` 证据：root `node_modules` 下 6 个被 Vite alias 的 `@uiw/*`、`@codemirror/*`、`@lezer/common` 全部缺失；UI package node_modules 仅存在三个 direct `@uiw/*`，state/language/common 也缺失。
-   根因确定为 Vite resolver 对扁平 root-hoist 布局的错误假设。修复方向是移除 CodeMirror/UIW/Lezer root aliases，让 pnpm 从 UI package 边界正常解析，并只为源码真实 direct imports 补 direct dependencies。
-   import 盘点确认 UI 源码直接使用的 `@uiw/*`、`@codemirror/lang-*` 和 `@codemirror/view` 均已声明；state/language/lezer common 仅是传递依赖。无需新增更多 direct dependencies。
-   已移除 editor 相关 root aliases，仅保留 `@ -> src`；pnpm/Vite 将从 UI package 边界和各依赖自身 peer graph 解析。临时 `deps-check` stage 已删除。
-   resolver 修复后的本地证据：安全静态门禁 24/24、UI Jest 65/65、Vite production build 和 `git diff --check` 通过；保留既有 chunk warnings。

# Clean Builder 验证结果

-   builder-only clean build 不再出现 CodeMirror/UIW root alias `ENOENT`，证明 Vite resolver 根因修复有效。
-   当前首个失败已推进到 `flowise-components` TypeScript：缺失 `mem0ai`、Bedrock runtime、OpenTelemetry、multer/storage、turndown 等模块，并有 uuid declaration 与 Mem0 interface 冲突。
-   这是一组独立的 components dependency/type contract 问题；不得回滚已验证的 UI resolver 修复，也不得一次性把所有错误归因于同一个包。
-   manifest/import 映射确认：components 直接 import 的 storage、OpenTelemetry、Bedrock、Mem0 和 turndown 模块均未在 components manifest 声明；multer/storage/turndown 只由 server manifest 声明，其他若干仅由传递依赖提供。
-   `uuid` 已是 components direct dependency，需单独检查包内 types 与 TypeScript module resolution；Mem0 interface conflict 也需在 direct package 可解析后独立验证。
-   开发机 components `tsc --noEmit` 通过，说明本地 root hoist 隐藏了依赖缺口；clean builder 结果才是发布证据。
-   `uuid@10.0.0` package 未声明/携带 `.d.ts`，clean components 需要显式 `@types/uuid`。storage/turndown 同样需要对应 type packages。
-   Mem0 `NodeFields` 同时继承 `Mem0MemoryInput` 与已继承它的 `Mem0MemoryExtendedInput`，且后者重定义 `memoryOptions`，造成真实冲突；应移除重复继承并用 `Omit<Mem0MemoryInput, 'memoryOptions'>` 定义扩展。
-   本地可用的 uuid declarations 来自 hoisted `@types/uuid@9.0.8`；lockfile 中的 `@types/uuid@10.0.0` 是 stub，不作为 components 类型依赖目标。
-   `@mem0/community` 的 `Mem0MemoryInput` 本身引用 `mem0ai` 的 `MemoryOptions | SearchOptions`；components 应显式依赖 lock 中的 `mem0ai@2.1.16`，并移除 NodeFields 的重复基类继承。
-   在修改 manifest 前，使用 TypeScript AST 扫描 components 全部静态 imports 与 direct dependencies，避免只按当前错误逐项补漏。

# Clean Builder 根因修正与最终结果

-   AST 扫描确实识别到 14 个 components 未直接声明的 import，但它们不是本轮 clean build 的首要根因。
-   对照仓库 `.npmrc` 与上游 Dockerfile 后确认：多阶段 Dockerfile 在 frozen install 前漏复制 `.npmrc`，导致 `shamefully-hoist=true` 等既有 workspace 布局契约未生效；因此没有把 14 个 transitive 包粗暴复制进 manifest。
-   Dockerfile 补入 `.npmrc` 后，干净 `linux/amd64` builder 构建 4/4 workspace 通过；components、UI、server、API documentation 全部成功。
-   runtime 首次验收发现 CMD 依赖未安装的 pnpm，候选未部署；改为已实测的 Node/Oclif CLI 后，本地和远端默认启动均返回 `pong`。
-   最终 artifact 为 `/opt/flowise/releases/flowise-node24-20260710-authorized-v2.tar.gz`，大小 1,132,842,786 bytes，SHA256 `8ba7158f88f13411a5f5e609d96ed29abd311d51745401507824521f4b8810a4`。
-   生产反向代理是容器 `ai_video_nginx`，upstream 为 `172.20.0.1:3000`。第一次使用 localhost bind 导致 502 并已回滚；第二次使用私有 bridge bind 后联合门禁通过。

# Gate A 本地验证证据

-   安全静态/认证 contract：18 passed、0 failed、0 warnings。
-   `git diff --check`：通过。
-   server `XSS.test.ts`：1 suite、34 tests 通过；server `tsc --noEmit`：通过。
-   UI Jest：2 suites、65 tests 通过。
-   UI Vite production build：21176 modules transformed，构建通过；主 chunk 约 5.74 MB，保留既有 chunk/dynamic import warning。
-   Compose 使用 `.env.production.template` 解析通过；本地未设置 Deepseek/Kimi/OpenAI key，因此仅出现空值 warning，未调用 provider。
-   当时构建身份：git `bb773ffa710bd22639c4ba2643413a0ea2b679d3`，dirty tree 包含 171 个 tracked changes 和 27 个 untracked entries。镜像只能描述为该工作区快照制品，不能描述成仅由 git SHA 可重建。
-   主机 `/System/Volumes/Data` 仅剩约 11 GiB；在跨架构镜像构建前必须核对 Docker 可回收空间和预期镜像大小。
-   Docker 当前 images 17.15 GB、containers 4.877 GB、build cache 2.834 GB；只有约 843.8 MB private build cache 可安全视为直接可回收候选。
-   本地旧 `flowise-chinese:latest` 是 `linux/arm64`、Node 20、约 845 MB，不能交付给 `linux/amd64` 生产服务器。
-   约 38.84 GB reclaimable volumes 可能属于其他项目运行数据，本批禁止删除。制品交付改为压缩流上传并双端校验，避免额外本地 tar 占用。

# 2026-07-10 最终生产验收

-   运行容器 healthy、restart count 0，Node `v24.18.0`，image ID `sha256:3c66e08b50562ab856328d669b611d000ccee6c9467f1560b7b8b4ba0b86fad9`。
-   端口仅发布为 `172.20.0.1:3000`；gateway、Nginx upstream 和公网 HTTPS `/ping` 均返回 `pong`，公网域名 `:3000` 连接拒绝。
-   GET `/api/v1/auth/resolve` 返回 405、无内部标记；POST 返回 200 和 `/signin`。
-   非法 Origin preflight 返回 200 但无 `Access-Control-Allow-Origin`；启动后 Node engine、AppleDouble、auth-secret、TypeError 日志匹配均为 0。
-   `/signin` 桌面/390px、`/register` redirect、`/forgot-password` 390px 均通过浏览器验收，未提交表单或触发外部发送。
-   备份目录：`/opt/flowise/backups/authorized-node24-20260710T053915Z`；rollback tag：`flowise-chinese:rollback-20260710T053915Z`。
-   `provider_call=false`、`secrets_read=false`；Compose 仅报告 Deepseek/Kimi/OpenAI key 未设置并置空。

# Batch 6A 安全头所有权生产验收

-   修复前 `scripts/verify-production-edge.sh` 为 10 passed、4 failed；失败项仅为 HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 各出现 2 次。
-   app 直连仍分别输出 CSP 与四个安全头；公网边缘契约改为 Nginx 隐藏四个上游副本、由 Nginx 各输出一次，CSP 继续由 app 输出一次。
-   生产持久化配置 `/opt/ai-video/deploy/lighthouse/nginx.conf` 和容器 `/etc/nginx/nginx.conf` 的 SHA256 均为 `7a67c22f303dbe0b0c6a80c8839b25d6d5d01bb8e62bbaec0df0326c0f802b23`。
-   首次使用替换 inode 后 reload，门禁检测到运行中单文件 bind mount 仍读取旧配置并自动回滚；没有把容器 health 当作公网成功证据。
-   最终使用 Compose `--no-deps --force-recreate nginx` 只重建共享代理服务，Flowise/Postgres 未重启。回滚备份为 `/opt/ai-video/deploy/lighthouse/backups/nginx.conf.20260710T080129Z.flowise-header-owner-recreate`。
-   修复后 edge smoke 14/14、静态门禁 33/33、`git diff --check` 全部通过；HTTP 301、HTTPS `pong`、auth GET/POST、恶意 Origin CORS 与公网 3000 拒绝连接均保持合约。
-   Flowise/Nginx restart count 均为 0；新鲜日志 `nginx_error=0`、`flowise_critical=0`，共享 `video.lute-tlz-dddd.top/health` 返回 200。
-   浏览器桌面 `1440x900` 与移动 `390x844` console 均为 0 error/0 warning；移动 `clientWidth=scrollWidth=390`、视口外控件数 0。
-   有效截图为 `output/playwright/production-edge-header-20260710/.playwright-cli/page-2026-07-10T08-05-04-806Z.png` 与 `page-2026-07-10T08-05-35-474Z.png`；渲染异常的黑屏中间截图未作为证据并已删除。

# 2026-07-12 Task 5 CSP/Request Source Contract

-   Commit `137256127d42e787faaa0292e56bb8d4da75ace6` 已通过独立复审；server focused suites `127/127`、UI `65/65`、TypeScript、focused ESLint、UI build 与 static security `52/52` 通过。
-   复审修复把统一 CSP/iframe/direct-deploy fallback header middleware 安装在 report receiver 之前，因此早返回的 `204/400/413/415` 也保留相同 header contract。
-   July 12 生产 L3 仍为 CSP enforcement only：`Content-Security-Policy-Report-Only=0`、`Reporting-Endpoints=0`，现行 CSP 含 `unsafe-eval`。Task 5 未部署，`production unchanged`。

# 2026-07-10 Batch 6B 历史本地验收（已由 Task 5 取代）

-   `IFRAME_ORIGINS` 改为结构化 exact-origin 解析：默认 `'self'`，规范化并去重 HTTPS origin；拒绝 bare/未知 keyword、控制字符/分号、空 CSV 项、URL credential/path/query/fragment、远程 HTTP、production wildcard 及 `'none'`/wildcard 混用。非法配置在启动阶段 fail-fast，错误不回显输入值。
-   CSP 改为单点生成的 `compat -> no-eval -> strict-script -> strict` 单调模式；默认 `compat` enforcement 与 `off` report-only，非法模式、非严格收紧候选、缺失/非法 `APP_URL` 以及 report-only 搭配 `TRUST_PROXY=true` 均在 handler 安装前失败。
-   新 report receiver 位于全局 50 MB parser 之前，仅接收三类 CSP/Reporting API media type，route-local body 上限 16 KiB、120 次/分钟，并仅记录 directive、disposition、status、document origin 与 blocked origin/特殊值。测试覆盖 query、fragment、source sample、cookie 和任意字段不进入日志。
-   UI bootstrap 已从 `index.html` 的 inline script 外置到同源 `/global.js`；模板与 Compose 增加 `CSP_ENFORCEMENT_MODE=compat`、`CSP_REPORT_ONLY_MODE=off`，没有新增依赖或 secret。
-   TDD 证据：最初 RED 分别证明 `parseIframeOrigins`、CSP policy module 与 report receiver 不存在；实现后 3 个 focused suites 转绿。完整 server Jest 为 33/33 suites、967/967 tests，server TypeScript、focused ESLint 与 server build 均通过。
-   完整 server Jest 首轮暴露既有 `chatflows/index.test.ts` 对 `uuid` 的局部 mock 只提供 `validate`、缺少 `v4`，导致测试受执行顺序影响；补齐同一 mock 合约后单套与全量顺序均通过，没有修改业务实现。
-   UI Jest 2/2 suites、65/65 tests，production build 21176 modules；静态安全门禁 52/52、Compose template render 与 `git diff --check` 通过。既有大 chunk 和 dynamic/static import warning 继续作为 Batch 7 技术债。
-   隔离 production-mode HTTP fixture 验证 enforced/report-only/`Reporting-Endpoints` headers，report receiver 对合法、畸形和超大 payload 分别返回 `204/400/413`，rate-limit headers 存在；非法 report mode 与不受限 proxy trust 在安装业务 handler 前终止启动。
-   本地真实浏览器 `/signin` 正常渲染，console 0 error/0 warning，`ReportingObserver` 捕获 `type=csp-violation`、`directive=script-src`、`disposition=report`。浏览器后台自动 POST 在本地 HTTP fixture 未观测到，因此只证明 violation 生成与手工 endpoint 合约，不声明 telemetry delivery 已验收。
-   build scan 在 4 个 chunk 中发现 8 处 `Function("return this")`，另有 1 处 regenerator fallback；这是 `no-eval` enforcement 的实测 blocker。生产必须先以 `compat` enforcement + `no-eval` report-only 观察认证后 lazy workflows，再决定根因移除和逐级晋级。
-   本地浏览器证据保存于 `output/playwright/batch6b-csp-local/`。边界：`production unchanged`、`provider_call=false`、`secrets_read=false`、`production_write=false`。
