## ADDED Requirements

### Requirement: Token 估算器估算消息 token 数
系统 SHALL 提供 token 估算器，基于字符数/4 近似估算消息的 token 消耗。

#### Scenario: 估算单条消息 token 数
- **WHEN** 给定一条 content 长度为 N 字符的消息
- **THEN** 估算结果 SHALL 为 `Math.ceil(N / 4)`

#### Scenario: 估算多条消息 token 总数
- **WHEN** 给定一个消息数组
- **THEN** 估算结果 SHALL 为各消息 token 估算值的累加和

### Requirement: 压缩分割算法按 token 预算分割消息列表
系统 SHALL 将消息列表按 token 预算分割为 head（旧消息，将摘要）和 recent（最新消息，保留原文）。

#### Scenario: 在预算内无需分割
- **WHEN** 全部消息 token 总数 <= keepTokens 预算
- **THEN** head 为空数组，recent 为全部消息

#### Scenario: 超出预算时从最新消息向前累积
- **WHEN** 总 token 超出 keepTokens 预算
- **THEN** 从最新消息向前遍历累积 token，达到预算时分割，recent 包含预算内的最新消息，head 包含剩余旧消息

#### Scenario: 边界消息按 token 比例切分
- **WHEN** 累积到某条消息时超出预算
- **THEN** 该条消息按 token 比例切分，确保 recent 不超出预算

### Requirement: 摘要生成调用 LLM 输出结构化摘要
系统 SHALL 调用 LLM 生成结构化摘要，包含 Objective、Important Details、Work State、Next Move、Relevant Files 五段。

#### Scenario: 首次生成摘要
- **WHEN** 不存在现有摘要，传入 head 消息
- **THEN** 调用 LLM 生成结构化摘要，输出包含 ## Objective、## Important Details、## Work State、## Next Move、## Relevant Files 五个段落

#### Scenario: 增量更新摘要
- **WHEN** 存在现有摘要，传入新的 head 消息和 existingSummary
- **THEN** 使用增量更新 prompt 调用 LLM，输出更新后的结构化摘要

### Requirement: 压缩触发在 Agent Loop 每轮开始前检查
系统 SHALL 在 Agent Loop 每轮 `while(true)` 开始时检查是否需要上下文压缩。

#### Scenario: 低于阈值时不触发压缩
- **WHEN** 当前消息总 token 数 <= (contextWindow - maxOutput - buffer)
- **THEN** 不执行压缩，本轮正常继续

#### Scenario: 超出阈值时自动触发压缩
- **WHEN** 当前消息总 token 数 > (contextWindow - maxOutput - buffer)
- **THEN** 执行 select 分割 + generateSummary 生成摘要 + 创建 CompactionMessage 存入 MessageStore，并发出 EventBus 事件

#### Scenario: 压缩后历史加载从检查点开始
- **WHEN** 压缩完成后，后续 `loadHistoryForLLM` 调用
- **THEN** 返回 compaction 摘要 + recentContext 的展开消息

### Requirement: Overflow 错误时自动恢复
系统 SHALL 在捕获 LLM 的 context overflow 错误时，自动触发压缩并重试当前 turn。

#### Scenario: Assistant 尚未输出时触发压缩重试
- **WHEN** LLM 返回 context overflow 错误，且 assistant 尚未开始输出（textContent 为空）
- **THEN** 触发压缩，然后重试当前 turn

#### Scenario: 压缩后重试成功
- **WHEN** overflow 触发压缩后重试
- **THEN** 新的 LLM 请求使用压缩后的消息列表，成功获得响应