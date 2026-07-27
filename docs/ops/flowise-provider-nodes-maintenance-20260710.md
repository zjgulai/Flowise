---
title: Flowise DeepSeek and Kimi provider node maintenance
date: 2026-07-10
status: current
provider_call: false
secrets_read: false
production_write: false
last_verified_l2: 2026-07-12
---

# Flowise DeepSeek 与 Kimi 节点维护说明

本文档是 DeepSeek 与 Kimi Chat Model 节点的当前维护入口。历史研究文档只用于追溯，不代表当前运行契约。

## 本批边界

-   `provider_call=false`
-   `secrets_read=false`
-   `production_write=false`
-   测试响应全部由本地 fixture 提供，不读取真实凭证，不向 provider 发请求。

## Stage 0 源码证据（2026-07-12）

-   Provider hardening 的已复审源码提交为 `b73a3c89586de994bc840cfb8dff50a27d81c057`。
-   Node `v24.18.0` / pnpm `10.26.0` 下，Provider 定向 Jest 为 `225/225`，ESLint、`tsc --noEmit`、components build 与静态安全门禁均通过；独立复审结论为通过。
-   以上只证明 Stage 0 本地源码已验收，尚未部署到生产；不得据此宣称真实 Provider 可用或生产已验证，边界继续保持 `provider_call=false` 与 `production unchanged`。

## 单一事实源

| 范围                    | 文件                                                        |
| ----------------------- | ----------------------------------------------------------- |
| DeepSeek 节点           | `packages/components/nodes/chatmodels/Deepseek/Deepseek.ts` |
| Kimi 节点               | `packages/components/nodes/chatmodels/ChatKimi/ChatKimi.ts` |
| 共享 provider 校验      | `packages/components/nodes/chatmodels/providerUtils.ts`     |
| 模型目录                | `packages/components/models.json`                           |
| HTTP SSRF/redirect 防护 | `packages/components/src/httpSecurity.ts`                   |
| 自定义 header 防护      | `packages/components/src/headerValidation.ts`               |

## 当前契约

### Credential

-   两个节点都要求选择对应 credential；空值在创建模型前失败。
-   Kimi 不允许回退到进程中的 `OPENAI_API_KEY`。
-   DeepSeek 显式传递 LangChain `ChatDeepSeek` 实际读取的 `apiKey` 字段。
-   错误和测试不得输出 credential 值。

### Endpoint 与 transport

-   DeepSeek 默认 Base Path：`https://api.deepseek.com`。
-   Kimi 默认 Base Path：`https://api.moonshot.cn/v1`。
-   Base Path 必须使用 HTTPS，不得包含 URL credential、query 或 fragment。
-   默认只允许官方 origin；兼容网关必须通过 `DEEPSEEK_BASE_URL_ALLOWLIST` 或 `KIMI_BASE_URL_ALLOWLIST` 明确加入。
-   allowlist 值是逗号分隔的 HTTPS origin，不得包含路径。
-   `Base Options` 仅表示 HTTP headers，并经过受保护 header 校验；不能用它传递请求体字段，也不能覆盖 `Authorization`、`X-Api-Key`、token 或 cookie 等 credential-bearing headers。
-   所有请求通过 `secureFetch`，每一跳都在发出请求前完成 DNS/IP、HTTPS 与配置 Base Path origin 复检。
-   Provider transport 即使在 `HTTP_SECURITY_CHECK=false` 时也强制使用默认 deny list；其中包含 RFC1918、CGNAT `100.64.0.0/10`、metadata/link-local、loopback 与 IPv6 unspecified `::` 等范围。
-   301/302/303/307/308 跳转到其他 origin 或降级到 HTTP 时，在第二次请求前失败，因此不会向目标转发 Authorization 或 body；同源跳转按 HTTP method/body 语义处理。
-   SDK timeout 单位为毫秒；LangChain 外层重试固定为 0，避免单次超时被额外重试放大。
-   调用方 `AbortSignal` 必须传到安全 transport。

### 模型与参数

-   DeepSeek 默认 `deepseek-v4-flash`；目录包含 `deepseek-v4-flash` 与 `deepseek-v4-pro`。
-   `deepseek-reasoner` 与 Kimi K2.7 thinking-only 模型不进入目录；节点也不展示 thinking/reasoning controls。
-   旧 flow 若显式启用 `thinking=true`、设置 DeepSeek `reasoningEffort`，或引用上述 thinking-only 模型，会在读取 credential 和发送请求前本地失败。
-   DeepSeek V4 与 Kimi K2.5/K2.6 请求显式发送 `thinking: { type: "disabled" }`；这是当前 transport 无法保证 `reasoning_content` 跨响应和后续 tool/agent 请求保真的 fail-closed 边界。
-   Kimi 默认 `kimi-k2.6`；目录保留 K2.5、K2.6 与 Moonshot V1。K2.5/K2.6 显式参数使用 `temperature=0.6`、`top_p=0.95`、两个 penalty 为 `0`。
-   Kimi K2 使用 `max_completion_tokens`，不发送已弃用的 `max_tokens`。
-   DeepSeek temperature 限定为 `0..2`。
-   空数值不写入模型配置；非法、非有限或越界数值在初始化阶段失败。
-   新 DeepSeek V4 model entries 不写 `input_cost`/`output_cost`；币种、单位和 cache hit/miss 未统一前，pricing normalization 延后处理。

## 本地验收

使用仓库要求的 Node 24 与 pnpm 10 运行：

```bash
pnpm --filter flowise-components exec jest \
  nodes/chatmodels/providerUtils.test.ts \
  nodes/chatmodels/Deepseek/Deepseek.test.ts \
  nodes/chatmodels/ChatKimi/ChatKimi.test.ts \
  nodes/chatmodels/ProviderCatalog.test.ts \
  src/httpSecurity.test.ts \
  src/headerValidation.test.ts \
  --runInBand
pnpm --filter flowise-components exec tsc --noEmit
pnpm --filter flowise-components build
bash scripts/verify-security.sh
```

完成声明还必须包含 compiled node load smoke。该 smoke 只能加载构建产物与读取 metadata，不得调用 `invoke`、`stream` 或 provider model-list API。

## Provider 升级检查表

1. 只从 provider 官方文档核对 base URL、模型 ID、弃用日期和固定参数。
2. 先更新 contract test，使旧实现出现可解释的 RED。
3. 更新节点与 `models.json`，不得静默删除仍处于兼容期的模型 ID。
4. 检查 credential 是否必填、header 是否受校验、请求是否仍走 `secureFetch`。
5. 跑定向测试、类型检查、lint、build、安全回归和 compiled-load smoke。
6. 真实 provider smoke 必须单独授权，并使用测试账户、费用上限和脱敏证据。

## 已知未完成项

-   `reasoning_content` 的端到端 UI 展示与持久化仍需单独产品批次验证。
-   模型成本字段缺少统一的币种、每 token/每百万 token 与 cache hit/miss schema；本批不为 Kimi 新模型写入推测成本。
-   当前目录更新仍依赖人工核对官方文档，尚未建立带审核门禁的自动同步。
-   本批未做真实 provider 调用或生产部署验收。
