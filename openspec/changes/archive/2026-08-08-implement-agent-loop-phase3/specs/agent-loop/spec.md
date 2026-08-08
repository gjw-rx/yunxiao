## ADDED Requirements

### Requirement: AgentLoop 主循环入口
AgentLoop SHALL 提供 `run(sessionId: string, userText: string): Promise<void>` 方法作为主循环入口。调用时 SHALL 先将用户消息追加到 MessageStore，然后进入循环。

#### Scenario: 简单对话无工具调用
- **WHEN** 调用 `run(sessionId, "你好")` 且 LLM 未返回工具调用
- **THEN** SHALL 追加 user 消息到 MessageStore，调用 LLM，将 assistant 回复追加到 MessageStore，通过 EventBus 发出 content 事件和 stream_end 事件

#### Scenario: 带工具调用的对话
- **WHEN** LLM 返回 toolCall 事件
- **THEN** SHALL 收集所有 toolCall，追加含 toolCalls 的 assistant 消息到 MessageStore，经 ToolRouter 执行每个工具，追加 tool 结果消息到 MessageStore，继续下一轮循环

#### Scenario: 多轮工具调用
- **WHEN** LLM 在工具结果返回后再次返回 toolCall
- **THEN** SHALL 继续执行工具并续轮，直到 LLM 不再返回工具调用

### Requirement: 流式事件处理
AgentLoop SHALL 消费 LLMProvider 返回的 LLMEvent 异步生成器，将事件转发到 EventBus。

#### Scenario: textDelta 事件转发
- **WHEN** LLMEvent 类型为 textDelta
- **THEN** SHALL 通过 EventBus 发出 content 事件，payload 包含 text 字段

#### Scenario: toolCall 事件收集
- **WHEN** LLMEvent 类型为 toolCall
- **THEN** SHALL 将其收集到 pendingToolCalls 数组中，不立即执行

#### Scenario: usage 事件转发
- **WHEN** LLMEvent 类型为 usage
- **THEN** SHALL 通过 EventBus 发出 token_usage 事件

#### Scenario: finish 事件判断续轮
- **WHEN** LLMEvent 类型为 finish
- **THEN** SHALL 根据 pendingToolCalls 是否为空判断是否续轮：非空则执行工具并续轮，空则结束循环

#### Scenario: error 事件处理
- **WHEN** LLMEvent 类型为 error
- **THEN** SHALL 通过 EventBus 发出 error 事件，跳出循环

### Requirement: 工具执行集成
AgentLoop SHALL 将 LLM 返回的 toolCalls 经 ToolRouter 执行，并将结果回传给 LLM。

#### Scenario: 工具调用转换为 ToolRouter 格式
- **WHEN** 收集到 toolCall（id/name/arguments）
- **THEN** SHALL 转换为 core 层 ToolCall 格式（call_id/tool/args/site='local'），arguments 从 JSON 字符串解析为对象

#### Scenario: 工具执行结果转换为 tool 消息
- **WHEN** ToolRouter 返回 ToolResult
- **THEN** SHALL 将结果转换为 tool 消息（role='tool', toolCallId=call_id, content=result 或 error），追加到 MessageStore

#### Scenario: 工具执行错误不中断循环
- **WHEN** 工具执行返回 status='error' 或抛出异常
- **THEN** SHALL 将错误信息作为 tool 消息内容追加到 MessageStore，继续循环让 LLM 处理错误

#### Scenario: 工具状态变更通知
- **WHEN** 工具开始执行或执行完成
- **THEN** SHALL 通过 EventBus 发出 tool_state_change 事件

### Requirement: 中断处理
AgentLoop SHALL 支持通过 `cancel()` 方法中断正在执行的循环。

#### Scenario: 中断 LLM 流式响应
- **WHEN** 调用 cancel() 时 LLM 正在流式响应
- **THEN** SHALL 通过 AbortController 中止 fetch 请求，停止消费 LLMEvent 流

#### Scenario: 中断后追加 interrupted 消息
- **WHEN** 中断发生后已部分输出文本
- **THEN** SHALL 追加 assistant 消息（content 为已收到的部分文本）到 MessageStore，通过 EventBus 发出 stream_end 事件

#### Scenario: 中断标记 pending 工具
- **WHEN** 中断时有待执行的工具调用
- **THEN** SHALL 将待执行工具标记为 cancelled 状态

### Requirement: Max Steps 限制
AgentLoop SHALL 限制循环步数，防止无限循环。

#### Scenario: 达到最大步数
- **WHEN** 循环步数达到配置的 maxSteps（默认 50）
- **THEN** SHALL 设置 toolChoice 为 "none"，追加 MAX_STEPS_PROMPT 消息，让 LLM 输出最终总结后结束循环

#### Scenario: maxSteps 从配置读取
- **WHEN** AgentLoop 初始化
- **THEN** SHALL 从配置读取 maxSteps 值，未配置时使用默认值 50

### Requirement: run_state_change 事件
AgentLoop SHALL 在循环开始和结束时通过 EventBus 发出 run_state_change 事件。

#### Scenario: 循环开始
- **WHEN** run() 方法被调用并开始循环
- **THEN** SHALL 发出 run_state_change 事件，payload 包含 state='running'

#### Scenario: 循环正常结束
- **WHEN** 循环因 LLM 无工具调用而正常结束
- **THEN** SHALL 发出 run_state_change 事件，payload 包含 state='completed'

#### Scenario: 循环被中断
- **WHEN** 循环因 cancel() 被中断
- **THEN** SHALL 发出 run_state_change 事件，payload 包含 state='cancelled'

#### Scenario: 循环因错误结束
- **WHEN** 循环因 LLM error 事件或异常而结束
- **THEN** SHALL 发出 run_state_change 事件，payload 包含 state='failed'
