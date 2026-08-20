## Context

当前默认模型运行时由 `AISDKProvider` 统一调用 `streamText`，但 `createAiSdkModel` 固定使用 `@ai-sdk/openai-compatible`，模型配置存储也只接受 `provider=openai`。流式输出已经被归一化为本地 `LLMEvent`，AgentLoop 已围绕该契约完成 token 账、工具执行、取消和错误处理，因此新增 Anthropic 不应复制一套 Agent 主循环或手写 Messages SSE parser。

Anthropic Messages API 与 Chat Completions 的关键差异包括：system prompt 是顶层字段；工具调用和结果使用 `tool_use` / `tool_result` content block；流包含 message/content block 级事件；prompt caching 通过 cache-control breakpoint 启用；usage 将未缓存输入、缓存读取、缓存创建和输出分开报告。当前项目的 AI SDK 消息转换器还会给历史 tool result 填空 `toolName`，这对 OpenAI-compatible 可工作，但不足以稳定生成 Anthropic 工具结果。

约束包括：继续支持 VS Code `^1.99` 的 Extension Host；依赖必须与已锁定的 AI SDK 6.x 兼容；API Key 不得离开 SecretStorage；所有本地工具仍必须经 AgentLoop → ToolRouter → ApprovalGateway；新增/修改函数必须有中文 JSDoc，关键分支必须使用项目 logger 输出中文日志。

## Goals / Non-Goals

**Goals:**

- 以 `provider=anthropic` 通过原生 Messages API 调用 Claude，并允许官方端点或兼容代理 `baseURL`。
- 复用 AI SDK 的 Anthropic Provider 完成协议转换，使 AgentLoop、存储和 Webview 继续只依赖统一 LLM 契约。
- 保持文本、reasoning、工具调用、finish/error、取消、usage、token 账和缓存明细与 OpenAI-compatible 路径的产品语义一致。
- 将 `low`、`medium`、`high` 直接映射到 Anthropic 原生 effort，并保留未显式设置时的 Provider 默认行为。
- 为 Anthropic 启用可重复命中的 5 分钟 ephemeral prompt cache breakpoint，并准确记录 cache read/write usage。
- 兼容旧的模型档案与缺少 `toolName` 的历史工具结果。

**Non-Goals:**

- 不手写 Anthropic HTTP 客户端或 SSE parser，不引入 Anthropic 官方 SDK。
- 不接入 Bedrock、Vertex Anthropic、OAuth、Batch、Files、服务端 Web Search 或 MCP Connector 等 Anthropic 扩展能力。
- 不新增缓存 TTL、thinking token budget 或 Provider 私有选项的设置 UI。
- 不改变 token 价格/成本统计，不把缓存明细重复加入 total。
- 不让 Anthropic 绕过现有工具注册、审批、安全审计或结果治理。

## Decisions

### 1. 使用 `@ai-sdk/anthropic`，在现有 AI SDK runtime 内按 provider 创建模型

`createAiSdkModel` 改为显式分派：`openai` 继续调用 `createOpenAICompatible`，`anthropic` 调用 `createAnthropic`。依赖选择与现有 `ai@6.x` 兼容的版本并精确锁定，构建和 Extension Host smoke test 共同验证 Node 兼容性。模型工厂返回语言模型及稳定的 provider options key，调用层据此构造协议私有选项。

选择官方 AI SDK Provider 而非手写 Messages client，是因为项目已经以 AI SDK `fullStream` 作为协议归一化边界；该 Provider 已负责 `x-api-key`、`anthropic-version`、Messages content blocks、tool use/result 与 SSE 细节。备选方案“扩展 legacy provider 手写 Anthropic parser”会复制错误、取消、usage 和工具增量逻辑，因此不采用。

### 2. Anthropic 只允许 `ai-sdk` runtime，OpenAI 行为保持不变

模型配置存储允许 `openai | anthropic`。新建 Anthropic 模型在未填写地址时使用 `https://api.anthropic.com/v1`；自定义 `baseURL` 原样作为 API 前缀交给 Provider。`provider=anthropic` 与 `runtime=legacy` 的组合在保存校验和 Provider 创建处均被拒绝，并给出中文可操作错误；legacy 仍仅作为 OpenAI-compatible 回退路径。

这比让 Anthropic 静默忽略 `legacy` 更容易诊断，也避免用户误以为在使用另一个协议实现。旧档案的 `provider=openai`、默认 URL 和 runtime 含义不变。

### 3. 保持统一消息契约，但为 tool result 补齐可恢复的 `toolName`

普通 system/user/assistant 消息继续先转换为 AI SDK `ModelMessage`，由 Anthropic Provider 将 system 提升为 Messages 顶层 system，并把 assistant tool calls 与 tool results 编码为 `tool_use` / `tool_result`。`ToolMessage`、持久化消息及相关转换增加可选 `toolName`；新写入记录必须保存实际工具名。

读取旧记录时，历史加载器通过 `toolCallId` 在前序 assistant `toolCalls` 中恢复名称；只有无法配对的损坏记录才沿用既有历史清理/拒绝逻辑，不发送空工具名。这样既满足 Anthropic 协议，又无需变更 ToolRouter 的调用形状。备选方案“在转换器中始终使用空字符串”会生成 Provider 无法验证的 tool result，因此不采用。

### 4. 继续以 AI SDK `fullStream` 和最终 usage 作为唯一归一化入口

`AISDKProvider` 对两类 provider 共用 `mapStreamPart`：text、reasoning、完整 tool call、finish、error 和 abort 仍映射为同一 `LLMEvent` 序列。每次调用只接受最终 `totalUsage` 作为权威 usage；中间 step 或 Anthropic message delta usage 不得重复记账。若 AI SDK Anthropic Provider 暴露的字段不足，则只在 stream adapter 的 provider metadata 适配层补齐，AgentLoop 不解析 Anthropic 原始事件。

错误日志包含 provider、model、阶段和有界错误摘要，但不记录 API Key、鉴权 header、完整请求体或可能含敏感信息的原始响应。

### 5. 按 Anthropic usage 语义归一化总输入、缓存和 reasoning

Anthropic 原始 usage 的 `input_tokens` 是未从缓存读取、也未用于创建缓存的输入部分，因此归一化后：

- `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
- `noCacheTokens = input_tokens`
- `cacheReadTokens = cache_read_input_tokens`
- `cacheWriteTokens = cache_creation_input_tokens`
- `outputTokens = output_tokens`
- `reasoningTokens = output_tokens_details.thinking_tokens`（AI SDK 提供时）
- `totalTokens = inputTokens + outputTokens`（Provider 未提供独立有效 total 时）

归一化结果继续遵守现有有限非负整数和组成项不超过总量的校验。reasoning 缺失时继续使用 reasoning delta 文本估算；任何缺失的 cache 字段保持缺失，不伪造命中。缓存读取/创建只是 input 的组成，不额外增加 total。

### 6. Anthropic 使用 Provider 私有 cache breakpoint，不改变本地缓存模型

对 Anthropic 请求，消息转换阶段在最后一个可缓存的请求内容块设置 `providerOptions.anthropic.cacheControl={type:'ephemeral'}`，TTL 使用 Provider 默认 5 分钟。breakpoint 随每次请求落在完整历史前缀末端，使后续 step/turn 可以复用 system、工具定义和已完成历史；OpenAI-compatible 消息不增加 Anthropic metadata。

项目仍不维护或清理本地 prompt cache，缓存是否创建/命中以 Provider usage 为准。该方案比新增用户可配置 TTL 更符合本次最小范围；1 小时 TTL 和细粒度多 breakpoint 留待独立 change。

### 7. Anthropic 推理强度使用原生 `effort`

Provider options builder 按 provider 分派。Anthropic 将 `low`、`medium`、`high` 原样写入 `providerOptions.anthropic.effort`；未设置时不发送 effort，从而保留模型默认行为。`disabled`/`minimal` 仍属于内部兼容类型，但当前三档 UI 不产生这些值；若从旧内部调用出现，Anthropic 不伪造等价档位，而是省略并记录诊断。

采用原生 effort 而非在客户端维护固定 `thinking.budgetTokens` 表，是因为预算随 Claude 型号和 API 演进，固定映射会产生脆弱的模型判断。Provider 对不支持 effort 的型号返回明确上游错误，设置页不宣称所有型号都支持推理强度。

## Risks / Trade-offs

- [AI SDK Anthropic 版本与当前 AI SDK 6.x 或 VS Code Node 不兼容] → 精确锁版本，执行 compile、单元测试和 Extension Host smoke test，不使用 `latest`。
- [Anthropic usage 与 AI SDK 标准 usage 的 total/cache 口径不同] → 用录制 fixture 验证上述恒等式和大缓存命中场景，字段级校验失败时省略可选细分并记录日志。
- [旧 tool result 没有 `toolName`] → 通过匹配前序 assistant tool call 迁移到内存形状；无法恢复的孤立结果不发给 Provider。
- [自定义 Anthropic 代理只部分实现 Messages API] → 仅保证官方协议；保留可配置 baseURL，但不为非标准事件或鉴权方式增加隐式兼容分支。
- [原生 effort 并非所有 Claude 型号都支持] → 不做不可靠的型号白名单；让 Provider 返回清晰错误，未设置档位时不发送该选项。
- [cache breakpoint 使请求对象携带 Provider metadata] → metadata 仅在 Anthropic 转换路径注入，不持久化到会话消息，也不下发 Webview。
- [Anthropic 不支持 legacy 回退] → 在配置保存和创建 Provider 时提前拒绝；回滚时切回已有 OpenAI-compatible 模型档案。

## Migration Plan

1. 精确添加兼容 AI SDK 6.x 的 `@ai-sdk/anthropic`，先验证类型检查、打包和 Extension Host 加载。
2. 扩展 provider/model 配置与工厂分派，同时保持所有旧 OpenAI 档案读取结果不变。
3. 扩展消息与工具结果契约，先实现旧记录 toolName 恢复，再启用 Anthropic 模型调用。
4. 加入 Anthropic provider options、cache breakpoint 和 usage 归一化，并以离线录制流/Provider mock 覆盖文本、reasoning、工具、缓存、错误、取消。
5. 完成设置页与端到端回归后开放 `anthropic` 保存选项；OpenAI-compatible 路径持续作为默认。

回滚时删除/禁用 Anthropic Provider 分支和设置入口即可；旧 OpenAI 配置、消息与 tokenUsage 结构仍可读取。已保存 Anthropic 档案属于非破坏性数据，旧版本会明确报告 provider 不支持而不会泄露密钥或改写档案。

## Open Questions

- 无阻塞问题。1 小时缓存 TTL、Anthropic adaptive thinking 的更多私有选项以及 Bedrock/Vertex 鉴权均明确留待后续 change。

## 实现记录（Task 6.4 交付依据）

以下为落地实现核对后的具体依据，供交付核查：

- **Provider 依赖**：`@ai-sdk/anthropic` 精确锁定 `3.0.111`，与 `ai@6.0.248` 共用 `@ai-sdk/provider@3.0.15`（npm 完全去重，无 peer/engine 冲突）；Node `>=18`，Engine 匹配 Extension Host。
- **Anthropic 官方端点**：未填 baseURL 时使用 `https://api.anthropic.com/v1`（见 `modelConfig.ts` 的 `ANTHROPIC_DEFAULT_BASE_URL`），作为 Messages API 前缀交给 `createAnthropic({ baseURL, apiKey })`。
- **Messages 协议字段（离线 fixture 验证，见 `anthropicFixtures.ts`）**：
  - streaming 事件：`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` / `error`。
  - usage：`input_tokens`（未缓存输入）、`cache_read_input_tokens`、`cache_creation_input_tokens`、`output_tokens`、`output_tokens_details.thinking_tokens`。
  - 归一化恒等式（design.md Decision 5，fixture `anthropic-large-cache-read` 验证）：`inputTokens = noCache + cacheRead + cacheWrite`（191+11392+0=11583），`totalTokens = inputTokens + outputTokens`（11688），cache 明细不重复计入 total。
- **prompt cache breakpoint**：仅 Anthropic 且仅在转换后消息列表的最后一条消息的 `providerOptions.anthropic.cacheControl={type:'ephemeral'}` 注入（5 分钟 TTL），落在最后一个可缓存内容块；metadata 不进会话存储、不下发 Webview，OpenAI-compatible 请求体完全不变（测试覆盖）。
- **推理强度**：`low/medium/high` 原样写入 `providerOptions.anthropic.effort`（请求体 `output_config.effort`），未设置时不发送；不与 OpenAI-compatible 的 `reasoning_effort` 泄漏（测试覆盖）。
- **日志脱敏**：模型创建/调用/usage 日志仅含 provider、model、阶段、规格数值，不含 API Key、鉴权 header、完整请求体（`tokenModelAttribution` 序列化断言 + 实现仅打印 model/baseURL）。

