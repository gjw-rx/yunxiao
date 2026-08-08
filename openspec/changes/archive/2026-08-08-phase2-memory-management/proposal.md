## Why

Phase 1（模型连接层）已完成，LLM Provider 可发流式请求并返回事件。但当前会话历史仍依赖云端 SessionManager（v2 Run API），无本地消息存储。Phase 3 Agent Loop 需要一个本地消息存储来管理对话历史、支持 compaction 检查点，才能实现本地全栈 Agent 循环。Phase 2 记忆管理是 Agent Loop 的前置依赖。

## What Changes

- 新建 `src/memory/types.ts`：定义本地消息类型（SystemMessage / UserMessage / AssistantMessage / ToolMessage / CompactionMessage），带 `seq` 序号，支持 attachments 和 toolCalls
- 新建 `src/memory/messageStore.ts`：实现内存存储（`Map<sessionId, Message[]>`）+ VSCode `workspaceState` 持久化，支持 append / loadHistory / getCompactionPoint / clear / deleteMessagesAfter
- 新建 `src/memory/historyLoader.ts`：从 MessageStore 加载历史并转换为 `LLMMessage[]`，处理 compaction 检查点（compaction 消息 → system 消息）
- 限制：每个 session 最多 1000 条消息

## Capabilities

### New Capabilities
- `memory-message-store`: 本地消息存储与持久化，管理会话历史消息的增删查改，支持 VSCode workspaceState 持久化和 1000 条上限
- `memory-history-loader`: 历史加载器，从 MessageStore 加载消息并转换为 LLM 可用格式，处理 compaction 检查点

### Modified Capabilities
（无现有 spec 需修改）

## Impact

- 新增文件：`src/memory/types.ts`、`src/memory/messageStore.ts`、`src/memory/historyLoader.ts`
- 依赖：`src/llm/types.ts`（LLMMessage 类型用于转换）、VSCode API（workspaceState）
- 被影响：Phase 3 Agent Loop 将依赖 MessageStore 和 HistoryLoader；Phase 5 上下文压缩将写入 CompactionMessage
- 不修改现有文件
