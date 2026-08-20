# anthropic-messages-protocol Specification

## Purpose
TBD - created by archiving change add-anthropic-messages-protocol. Update Purpose after archive.
## Requirements
### Requirement: Anthropic 模型配置使用原生 Messages API
系统 SHALL 接受 `provider=anthropic` 的模型档案，并通过与当前 AI SDK 6.x 运行时兼容且精确锁定的 Anthropic Provider 调用原生 Messages API。未填写 API 地址时 SHALL 使用 `https://api.anthropic.com/v1`，填写自定义 `baseURL` 时 SHALL 将其作为 Messages API 前缀。API Key MUST 仅从 SecretStorage 注入 Provider，MUST NOT 下发 Webview、写入普通配置文件或出现在日志中。

#### Scenario: 保存并调用官方 Anthropic 模型
- **WHEN** 用户保存 `provider=anthropic`、Claude 模型名和 API Key，且未填写自定义 API 地址
- **THEN** 系统使用 Anthropic 官方 `/v1/messages` 协议调用该模型，设置页只显示 API Key 已配置状态

#### Scenario: 使用 Anthropic 兼容代理
- **WHEN** 用户为 Anthropic 模型配置合法的自定义 `baseURL`
- **THEN** Provider 以该地址作为 Messages API 前缀，并保持 Anthropic 消息与鉴权语义

### Requirement: Anthropic 仅使用 AI SDK runtime
`provider=anthropic` SHALL 仅与 `runtime=ai-sdk` 组合使用。系统 MUST 在保存配置时拒绝显式的 `runtime=legacy` 组合，并在 Provider 创建时再次防御性拒绝；系统 MUST NOT 将 Anthropic 请求发送到手写 OpenAI Chat Completions runtime。

#### Scenario: 拒绝 Anthropic legacy 配置
- **WHEN** 用户尝试保存或启动 `provider=anthropic` 且 `runtime=legacy` 的模型
- **THEN** 系统返回明确中文错误，不发起任何模型网络请求

### Requirement: Messages 消息与工具块保持协议合法
系统 SHALL 将本地 system、user、assistant 和 tool 消息转换为 Anthropic Messages 可接受的结构：system 指令 SHALL 由 Provider 作为顶层 system 发送，assistant 工具调用 SHALL 转换为 `tool_use`，工具结果 SHALL 转换为引用相同调用 ID 的 `tool_result`。每个工具结果 MUST 携带与对应 tool call 一致的工具名；本地工具仍 MUST 只经 ToolRouter 与审批网关执行。

#### Scenario: 带 system 指令的普通对话
- **WHEN** LLMRequest 包含 system 消息和多轮 user/assistant 历史
- **THEN** Anthropic 请求具有顶层 system 与合法的 Messages 对话轮次，AgentLoop 不包含 Anthropic 分支

#### Scenario: Claude 调用本地工具
- **WHEN** Claude 返回带调用 ID、工具名和 JSON 输入的 tool use
- **THEN** 系统发出统一 toolCall 事件，经 ToolRouter 执行，并在下一次 Anthropic 请求中发送同一调用 ID 与工具名的 tool result

#### Scenario: 恢复旧工具历史
- **WHEN** 旧持久化 tool result 缺少工具名，但前序 assistant tool call 包含相同调用 ID 和工具名
- **THEN** 历史加载器恢复工具名并生成合法 tool result，不向 Provider 发送空工具名

### Requirement: Anthropic 流归一化为现有 LLMEvent
系统 SHALL 通过 AI SDK `fullStream` 将 Anthropic Messages 流中的文本、reasoning、完整工具调用、结束原因和错误归一化为现有 `textDelta`、`reasoningDelta`、`toolCall`、`finish` 与 `error` 事件，并保持流顺序。用户取消 SHALL 传递到 Provider 请求，取消后 MUST NOT 再执行工具。

#### Scenario: 流式文本与思考
- **WHEN** Anthropic 流返回交错的 reasoning 与 text 增量
- **THEN** AgentLoop 按顺序收到统一 reasoningDelta 与 textDelta，Webview 复用现有渲染路径

#### Scenario: 流内错误
- **WHEN** Anthropic Provider 在流开始后返回错误事件
- **THEN** 系统发出一个用户可读的 error 事件并停止该次调用，不发出成功 finish

#### Scenario: 用户取消 Anthropic 请求
- **WHEN** 用户在 Claude 流式回复期间取消运行
- **THEN** AbortSignal 到达 Provider，之后的文本与工具调用均不再分发

### Requirement: Anthropic prompt cache 使用临时 breakpoint
系统 SHALL 仅在 Anthropic 请求的最后一个可缓存内容块设置 5 分钟 ephemeral cache breakpoint，使完整稳定前缀和已完成历史可被后续请求复用。cache metadata MUST NOT 写入持久化会话或发送到 Webview；系统 SHALL 以 Provider usage 判断缓存创建或命中，MUST NOT 伪造、本地维护或主动清理 Provider 缓存。

#### Scenario: 后续步骤复用请求前缀
- **WHEN** 同一运行的后续 LLM step 复用了相同 system、工具定义和已完成历史前缀
- **THEN** Anthropic 请求携带 ephemeral breakpoint，缓存命中时现有 token 账记录 Provider 返回的 cache read 明细

#### Scenario: OpenAI 请求不携带 Anthropic metadata
- **WHEN** 当前模型为 `provider=openai`
- **THEN** 消息与工具定义中不注入 Anthropic cacheControl 或其他 Anthropic provider options

### Requirement: Anthropic 协议日志不泄露敏感数据
Anthropic 模型创建、请求开始、usage、取消和失败关键步骤 SHALL 使用项目 logger 记录 provider、model、阶段和有界错误摘要。日志 MUST NOT 包含 API Key、鉴权 header、完整请求体或未经治理的工具结果。

#### Scenario: Anthropic 鉴权失败
- **WHEN** Provider 返回鉴权错误
- **THEN** 日志包含 provider、model 和失败阶段，且不包含 API Key 或请求鉴权 header

