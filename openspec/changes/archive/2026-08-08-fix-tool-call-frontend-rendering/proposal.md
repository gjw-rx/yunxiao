## Why

工具调用在前端聊天面板中存在多个渲染缺陷：模型决定调用工具时 UI 无感知（`tool_call` 事件从不发出）、`tool_result` 事件被静默丢弃、历史加载时工具调用步骤完全丢失、`diffResult` 命令前端有完整渲染代码但后端从不发送。用户输入指令后看不到工具调用过程，破坏了"模型思考 → 执行工具 → 拿到结果 → 回复"的透明度。

## What Changes

- 在 AgentLoop 收到 LLM `toolCall` 事件时发出 `tool_call` 事件，让 UI 在模型决定调用工具的瞬间就能感知
- 在 `chatPanel.ts` 的 `_forwardEvent` 中增加 `tool_call` 和 `tool_result` 两个 case，转发到 webview
- 在 webview 前端增加 `toolCall` 命令处理，创建工具调用的初始"pending"状态卡片（running 之前）
- 扩展 `HistoryEntry` 接口包含 `toolCalls` 字段，历史加载时恢复工具调用步骤到时间线
- 在 `localSessionManager.ts` 的 `loadHistory` 中保留 `tool` 角色消息，前端按需渲染
- 在 `diffViewer` 工具执行后发送 `diffResult` 命令，激活前端已有的 diff 卡片渲染
- 移除 `_forwardEvent` 中 `default: break` 对 `tool_result` 的静默丢弃

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tool-call-protocol`: 增加 `tool_call` 事件的发出时机和 `tool_result` 事件的转发规则
- `frontend-local-adaptation`: 前端处理 `toolCall` 命令创建 pending 状态工具卡片；历史加载恢复工具步骤；`diffResult` 命令接通
- `session-orchestration`: `HistoryEntry` 接口扩展 `toolCalls` 字段，`loadHistory` 保留工具消息

## Impact

- `src/agent/agentLoop.ts`: 新增 `tool_call` 事件发出
- `src/chatPanel.ts`: `_forwardEvent` 增加 `tool_call`/`tool_result` case；webview JS 增加 `toolCall` 命令处理
- `src/core/localSessionManager.ts`: `HistoryEntry` 接口扩展，`loadHistory` 逻辑调整
- `src/tools/diff/diffViewer.ts`: 执行后发送 `diffResult` 命令
- `src/core/eventBus.ts`: 无改动（`tool_call` 类型已定义）
