## 1. 类型适配层 (`src/agent/toolAdapter.ts`)

- [x] 1.1 创建 `src/agent/toolAdapter.ts`，实现 `toolSchemaToDefinition(schema: ToolSchema): ToolDefinition`，从 ToolSchema 提取 name/description/parameters，丢弃 permissions/site/canParallel
- [x] 1.2 实现 `llmToolCallToCoreToolCall(llmCall: LLMToolCall): ToolCall`，字段映射 id->call_id, name->tool, arguments(JSON字符串)->args(对象), site='local'，JSON 解析失败时 args 设为 {}
- [x] 1.3 实现 `toolResultToContent(result: ToolResult): string`，success 返回 result，error 返回 "Error: {error}"，cancelled 返回 "Cancelled: {error}"
- [x] 1.4 实现 `toolSchemasToDefinitions(schemas: ToolSchema[]): ToolDefinition[]`，过滤 site='local' 后批量转换

## 2. AgentLoop 核心类 (`src/agent/agentLoop.ts`)

- [x] 2.1 创建 `src/agent/agentLoop.ts`，定义 `AgentLoopConfig` 接口（maxSteps、workspaceRoots、maxFileSize、toolTimeoutMs、terminalOutputLimit、toolResultLimit）
- [x] 2.2 实现 `AgentLoop` 类构造函数，接收 provider、messageStore、toolRouter、toolRegistry、eventBus、config，初始化 AbortController
- [x] 2.3 实现 `run(sessionId, userText)` 主入口：追加 user 消息到 MessageStore，发出 run_state_change(running) 事件，进入主循环
- [x] 2.4 实现主循环 while(true)：加载历史（loadHistoryForLLM）、构建临时系统提示词、物化工具定义（toolSchemasToDefinitions）、构建 LLMRequest、调用 provider.chatCompletion
- [x] 2.5 实现流式事件消费：遍历 LLMEvent 生成器，textDelta->EventBus.emit(content)，toolCall->收集到 pendingToolCalls，usage->EventBus.emit(token_usage)，finish->判断续轮，error->跳出循环
- [x] 2.6 实现工具执行：finish 事件后若 pendingToolCalls 非空，追加 assistant 消息（含 toolCalls），逐个转换为 core ToolCall 经 ToolRouter 执行，结果转 tool 消息追加到 MessageStore，step++ continue
- [x] 2.7 实现循环结束：若 pendingToolCalls 为空，追加 assistant 消息，break，发出 run_state_change(completed) 和 stream_end 事件

## 3. 中断处理

- [x] 3.1 在 AgentLoop 中维护 `AbortController`，`cancel()` 方法调用 `controller.abort()`
- [x] 3.2 在流式消费中捕获 abort 异常，停止消费 LLMEvent 流
- [x] 3.3 中断后追加 assistant 消息（content 为已收到的部分文本）到 MessageStore，发出 run_state_change(cancelled) 和 stream_end 事件
- [x] 3.4 构建 ToolContext 时注入 `abortSignal`，使工具执行可被中断

## 4. Max Steps 限制

- [x] 4.1 在循环中维护 step 计数器，每轮工具执行后 step++
- [x] 4.2 在循环开始时检查 step >= maxSteps，达到时设置 toolChoice="none"，追加 MAX_STEPS_PROMPT 消息
- [x] 4.3 定义 MAX_STEPS_PROMPT 常量：提示 LLM 已达到最大步数，请总结已完成和剩余的工作

## 5. ToolContext 构建与工具执行集成

- [x] 5.1 实现 `buildToolContext(sessionId)` 方法，从 config 提取 workspaceRoots/maxFileSize/toolTimeoutMs/terminalOutputLimit/toolResultLimit，补充 sessionId 和 abortSignal
- [x] 5.2 在工具执行前发出 tool_state_change(running) 事件，执行后发出 tool_state_change(success/error/cancelled) 事件
- [x] 5.3 捕获工具执行异常（超时、拒绝等），转为 `{ status: 'error', error: message }` 的 ToolResult，不中断循环

## 6. 验证

- [x] 6.1 验证编译通过：`npx tsc --noEmit` 无类型错误
- [ ] 6.2 验证简单对话流程：用户消息 -> LLM 文本回复 -> stream_end
- [ ] 6.3 验证工具调用流程：用户消息 -> LLM toolCall -> 工具执行 -> tool 结果回传 -> LLM 最终回复
- [ ] 6.4 验证中断处理：调用 cancel() 后循环正确停止
- [ ] 6.5 验证 Max Steps：达到限制后禁用工具并让 LLM 总结
