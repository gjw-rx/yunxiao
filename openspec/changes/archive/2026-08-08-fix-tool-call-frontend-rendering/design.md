## Context

当前 AgentLoop 收到 LLM 的 `toolCall` 事件时仅存入 `pendingToolCalls` 数组（agentLoop.ts:154-159），不发出任何事件。工具调用信息只在执行前通过 `tool_state_change`（state='running'）传达。`tool_result` 事件被发出但 `_forwardEvent` 无对应 case 被丢弃。历史加载时 `HistoryEntry` 不含 `toolCalls`，`tool` 角色消息被过滤。前端 `showDiffCard` 完整实现但后端从不发送 `diffResult` 命令。

数据流：`streamParser → agentLoop → eventBus → chatPanel._forwardEvent → webview message handler → showToolState/showDiffCard`

## Goals / Non-Goals

**Goals:**
- 模型决定调用工具的瞬间 UI 即可感知（pending 状态卡片）
- `tool_result` 事件不再被静默丢弃
- 重新加载历史会话时工具调用步骤恢复显示
- `code.edit` 工具执行后前端显示 diff 卡片

**Non-Goals:**
- 不修改 `stream_end` 的发出时机（只在 loop 结束时发出，中间步骤不发）
- 不修改 trace 折叠逻辑（`finishTurn` 行为保持不变）
- 不修改 LLM 层的 `streamParser` 或 `openaiProvider`

## Decisions

### D1: 在 agentLoop 收到 toolCall 时发出 `tool_call` 事件

在 agentLoop.ts 第 154-159 行，收到 `event.type === 'toolCall'` 时，除了存入 `pendingToolCalls`，同时 emit 一个 `tool_call` 事件，payload 包含 `call_id`、`tool`、`args`。

**为什么**：EventBus 已定义 `tool_call` 类型（eventBus.ts:10），只是 AgentLoop 从未发出。利用已有类型无需新增 EventType。

**替代方案**：复用 `tool_state_change`（state='pending'）——不采用，因为 `tool_call` 语义更清晰（模型决定调用 vs 工具开始执行是两个不同时刻）。

### D2: `_forwardEvent` 增加 `tool_call` 和 `tool_result` case

在 chatPanel.ts `_forwardEvent` switch 中：
- `tool_call` → `postMessage({ command: 'toolCall', ...payload })`
- `tool_result` → `postMessage({ command: 'toolResult', ...payload })`

**为什么**：`tool_result` 已被 agentLoop 发出但被 default 丢弃。`tool_call` 需要转发让前端创建 pending 卡片。

### D3: 前端 webview 增加 `toolCall` 命令处理

在 message handler 中增加 `case 'toolCall'`，调用 `showToolState(tool, 'pending', undefined, call_id, args)`。复用已有的 `showToolState` 函数，传入 state='pending'。

**为什么**：`showToolState` 已支持创建 DOM 元素并挂到 trace。`getStatusIcon` 已有 pending 分支（返回时钟图标）。无需新增渲染函数。

### D4: `HistoryEntry` 扩展 `toolCalls` 和 `toolCallId` 字段

在 localSessionManager.ts 中：
- `HistoryEntry` 接口增加可选 `toolCalls?: Array<{ id: string; name: string; arguments: string }>` 和 `toolCallId?: string`
- `loadHistory` 不再过滤 `tool` 角色消息，全部返回
- 前端 `appendMsgFromHistory` 对 `tool` 角色消息渲染为工具结果步骤

**为什么**：当前 `loadHistory` 过滤掉 `tool` 角色消息且 `HistoryEntry` 不含 `toolCalls`，导致历史恢复时工具步骤完全丢失。

**替代方案**：只扩展 `HistoryEntry` 不保留 `tool` 消息——不采用，因为 `tool` 消息包含工具执行结果，恢复时需要显示。

### D5: `code.edit` 工具执行后发送 `diffResult` 命令

在 `CodeEditTool.execute` 返回 success 结果时，通过 EventBus emit 一个自定义事件，或在 `ToolResult.metadata` 中携带 diff 信息，由 chatPanel 拦截并发送 `diffResult`。

**采用方案**：在 `ToolResult.metadata` 中已有 `diff` 字段（editFile.ts:235）。在 chatPanel `_forwardEvent` 的 `tool_state_change` case 中，当 `tool === 'code.edit'` 且 `state === 'success'` 且 `output` 包含 `diff` 时，额外发送 `diffResult` 命令。

**为什么**：不需要修改 `CodeEditTool`，diff 数据已在 metadata 中。只需在 chatPanel 转发层增加拦截逻辑。

## Risks / Trade-offs

- [历史加载性能] 保留 `tool` 消息后历史列表变长 → 仅保留最近 N 条工具消息，旧消息折叠
- [事件冗余] `tool_call` + `tool_state_change(running)` 双事件 → 可接受，pending→running 是两个状态
- [diffResult 拦截耦合] chatPanel 需要知道 `code.edit` 的 output 结构 → 耦合度低，只检查 metadata.diff 是否存在
