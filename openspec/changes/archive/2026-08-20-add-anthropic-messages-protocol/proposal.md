## Why

当前模型连接层只允许 `provider=openai`，无法通过 Anthropic 原生 Messages API 接入 Claude；同时原生协议在 system 消息、工具结果、流式事件、usage 与 prompt cache 字段上均不同于 OpenAI Chat Completions。需要在既有 AI SDK 统一边界内补齐 Anthropic 协议，使 Claude 获得与现有 OpenAI-compatible 路径一致的流式对话、工具调用、token 记账、缓存观测和低/中/高推理强度体验。

## What Changes

- 新增 `anthropic` 模型服务配置与原生 Messages API 运行时，支持官方端点及兼容的自定义 `baseURL`，并保持 API Key 只存于 SecretStorage。
- 通过 AI SDK Anthropic Provider 转换 system、user、assistant、tool use/tool result 消息，消费 Messages 流并继续输出统一 `LLMEvent`，AgentLoop、ToolRouter、消息存储和 Webview 不感知上游协议差异。
- 将 Anthropic 的 input/output/thinking、cache read/cache creation usage 归一化到现有 token 账与会话/工作区统计；缓存明细只作为输入侧组成，不重复计入 total。
- 为 Anthropic 请求建立 prompt cache breakpoint，并保持现有稳定前缀与上下文压缩语义，使缓存命中可观测但不引入本地缓存或成本推算。
- 将现有 `low`、`medium`、`high` 推理强度映射为 Anthropic Provider 的原生 effort 选项；未设置时沿用 Anthropic 默认行为，不把协议分支泄漏到 AgentLoop 或 Webview。
- 保留 OpenAI-compatible 默认行为；Anthropic 不支持 `legacy` 手写 OpenAI 运行时，错误配置须在保存或 Provider 创建阶段明确拒绝。

## Capabilities

### New Capabilities

- `anthropic-messages-protocol`: 定义 Anthropic 模型配置、Messages API 请求/流式响应、工具消息、prompt caching、错误与取消的端到端行为。

### Modified Capabilities

- `ai-sdk-model-runtime`: 模型工厂从仅支持 OpenAI-compatible 扩展为按 provider 创建 OpenAI-compatible 或 Anthropic 原生模型，同时保持统一事件契约。
- `reasoning-level-control`: 增加 Anthropic 对低/中/高三档推理强度的原生映射规则。
- `token-usage-tracking`: 明确 Anthropic usage、thinking token 与 cache read/cache creation token 到现有账本字段的归一化与总量规则。
- `tool-call-protocol`: 工具结果历史须保留工具名，并可转换为 Anthropic 合法的 `tool_use` / `tool_result` 配对而不改变 ToolRouter 执行边界。

## Impact

- 主要影响 `src/llm/aiSdkModelFactory.ts`、`src/llm/aiSdkProvider.ts`、`src/llm/aiSdkMessageConverter.ts`、`src/llm/aiSdkStreamAdapter.ts` 与相关 LLM 类型、测试 fixture。
- 模型配置存储、设置页与 Provider 工厂需接受 `anthropic`，并对 `baseURL` 默认值、运行时兼容性和非敏感展示字段进行校验。
- 工具消息的内存/持久化契约需补充 `toolName`，旧记录仍须可读取并可从配对的 assistant tool call 恢复名称。
- 新增与当前 AI SDK 6.x、VS Code `^1.99` Extension Host 兼容且精确锁定的 `@ai-sdk/anthropic` 依赖；不新增 Anthropic 官方 SDK，也不修改 AgentLoop、审批网关或工具执行权限模型。
