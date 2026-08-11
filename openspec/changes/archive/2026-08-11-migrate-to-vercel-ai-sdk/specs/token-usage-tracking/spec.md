## MODIFIED Requirements

### Requirement: LLM usage 完整解析与透传
AI SDK 模型运行时 SHALL 从一次 `fullStream` 的最终 usage 元数据中解析 `inputTokens`、`outputTokens`、`totalTokens` 与 `reasoningTokens`（provider 提供时），并将其规范化为现有 `token_usage` 事件。`input_length` 字段 SHALL 反映本次请求的真实 prompt token 数：优先取规范化的 `inputTokens`，缺失时 SHALL 使用估算器对请求体（system prompt + 历史消息 + 用户输入 + 工具定义）估算，不得硬编码为 0。每次模型调用 SHALL 最多透传一条权威 usage 事件，避免中间 step usage 与最终 usage 重复记账。

#### Scenario: AI SDK usage 含完整字段
- **WHEN** AI SDK 最终 usage 包含 inputTokens=100、outputTokens=50、totalTokens=150、reasoningTokens=20
- **THEN** 运行时产出一条 usage 事件，`token_usage` 事件载荷中 `total_tokens=150`、`reasoning_tokens=20`、`input_length=100`

#### Scenario: usage 缺少 reasoningTokens
- **WHEN** AI SDK 最终 usage 只有 inputTokens 与 outputTokens，无 reasoningTokens
- **THEN** 系统对本次流中累积的 reasoning 增量文本估算 reasoning token，并以 `source=estimated` 标记

#### Scenario: usage 缺失时按请求体估算 input_length
- **WHEN** AI SDK 响应未携带 usage 数据，但 LLM 请求体包含 system prompt、历史消息、用户输入与工具定义
- **THEN** `input_length` 等于估算器对完整请求体的估算值，且标注 `source=estimated`

#### Scenario: 中间 step usage 与最终 usage 同时存在
- **WHEN** AI SDK 流同时产生中间 step usage 与最终 total usage
- **THEN** 系统仅使用最终 total usage 生成权威 token_usage 事件和本步骤 token 账

## ADDED Requirements

### Requirement: AI SDK cache token metadata is retained when available
When AI SDK final usage includes cache read or cache write token details, the token usage snapshot SHALL retain the values with their source metadata. Providers that omit cache details SHALL remain compatible and SHALL NOT produce fabricated cache values.

#### Scenario: Provider reports cache token details
- **WHEN** AI SDK final usage includes cache read tokens or cache write tokens
- **THEN** the persisted token usage snapshot retains those values and marks them as provider usage

#### Scenario: Provider omits cache token details
- **WHEN** AI SDK final usage does not include cache read or cache write details
- **THEN** token tracking leaves the cache fields absent and preserves the existing total, reasoning, tool-call, model-output, user-input, and context accounting
