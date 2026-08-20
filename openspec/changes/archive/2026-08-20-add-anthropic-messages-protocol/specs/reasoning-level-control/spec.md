## MODIFIED Requirements

### Requirement: Provider 将规范化档位映射为请求参数
系统 SHALL 由 LLM Provider 层把 `low`、`medium`、`high` 映射为上游请求参数，AgentLoop 与 Webview MUST 保持 provider agnostic。OpenAI-compatible 请求 SHALL 使用 reasoning effort；DeepSeek 请求 SHALL 同时启用 thinking 并遵守其 temperature 约束；Anthropic Messages 请求 SHALL 使用 Anthropic Provider 的原生 `effort` 选项。未显式设置档位时 SHALL 沿用对应 Provider 默认行为。

#### Scenario: OpenAI-compatible 模型使用中档
- **WHEN** AgentLoop 以 `medium` 调用 OpenAI-compatible 模型
- **THEN** AI SDK 或 legacy Provider 在各自协议中发送等价的 medium reasoning effort

#### Scenario: DeepSeek 模型使用高档
- **WHEN** AgentLoop 以 `high` 调用 DeepSeek 模型
- **THEN** Provider 启用 DeepSeek thinking、发送 high reasoning effort，并省略不兼容的 temperature

#### Scenario: Anthropic 模型使用低档
- **WHEN** AgentLoop 以 `low` 调用 Anthropic Messages 模型
- **THEN** AI SDK Provider 在 Anthropic provider options 中发送 `effort=low`，且请求不包含 OpenAI-compatible reasoning options

#### Scenario: Anthropic 模型使用中档或高档
- **WHEN** AgentLoop 以 `medium` 或 `high` 调用 Anthropic Messages 模型
- **THEN** AI SDK Provider 将选定档位原样映射为 Anthropic `effort`

#### Scenario: 旧模型没有显式档位
- **WHEN** AgentLoop 调用一个推理强度为未设置的旧模型档案
- **THEN** 非 DeepSeek Provider 不新增 reasoning 或 effort 参数，DeepSeek 继续采用变更前的默认思考行为
