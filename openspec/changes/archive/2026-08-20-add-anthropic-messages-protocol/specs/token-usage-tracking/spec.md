## ADDED Requirements

### Requirement: Anthropic usage 归一化到现有 token 账
AI SDK 模型运行时 SHALL 将 Anthropic Messages usage 归一化为现有 usage 与 tokenUsage 字段。规范化的 `inputTokens` SHALL 等于未缓存输入、cache read 与 cache creation 输入之和，`noCacheTokens` SHALL 对应未缓存输入，`cacheReadTokens` SHALL 对应 cache read，`cacheWriteTokens` SHALL 对应 cache creation，`outputTokens` SHALL 对应 Anthropic output。Anthropic 提供 thinking token 明细时 SHALL 映射为 `reasoningTokens`；缺失时 SHALL 沿用现有 reasoning 文本估算。每次调用 SHALL 最多产生一条权威 usage，缓存组成 MUST NOT 再次加入 `totalTokens`。

#### Scenario: Anthropic 返回完整 usage 与缓存明细
- **WHEN** Anthropic usage 报告 input=191、cacheRead=11392、cacheCreation=0、output=105、thinking=59
- **THEN** token 账记录 inputTokens=11583、noCacheTokens=191、cacheReadTokens=11392、cacheWriteTokens=0、outputTokens=105、reasoningTokens=59、totalTokens=11688

#### Scenario: Anthropic 创建 prompt cache
- **WHEN** Anthropic usage 报告 input=100、cacheCreation=2000、cacheRead=0、output=50
- **THEN** token 账记录 inputTokens=2100、cacheWriteTokens=2000、cacheReadTokens=0、totalTokens=2150，且 cacheWrite 不额外增加 total

#### Scenario: Anthropic 不返回 thinking 明细
- **WHEN** Anthropic 最终 usage 只含输入、缓存和输出字段，但流中包含 reasoningDelta
- **THEN** 系统保留权威输入、缓存和输出值，并按现有规则估算 reasoningTokens 且标记 estimated

#### Scenario: Anthropic cache 字段缺失
- **WHEN** Anthropic Provider 未提供 cache read 或 cache creation 明细
- **THEN** 系统保持相应缓存字段缺失，不根据模型名或请求 cache breakpoint 伪造数值

### Requirement: Anthropic usage 沿用现有持久化与统计语义
Anthropic tokenUsage 快照 SHALL 与 OpenAI-compatible 快照使用同一持久化、会话聚合和工作区按模型统计路径，并记录实际 `provider=anthropic` 与模型标识。缓存读取和写入 SHALL 作为输入侧明细显示，SHALL NOT 被当作额外调用量或费用。

#### Scenario: 工作区包含 OpenAI 与 Anthropic 用量
- **WHEN** 当前工作区同时持久化 OpenAI-compatible 和 Anthropic assistant tokenUsage 快照
- **THEN** 使用情况按 provider 与 model 分组统计，两类快照使用相同 total/输入/输出/缓存口径且互不混合
