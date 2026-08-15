## Why

用户在对话中常需要修正历史：误发送的输入、已失效的中间结果、想重来的某一步。当前插件只支持「整会话删除」，无法删除单条消息，也无法回滚某条用户输入及其引发的文件改动——一旦 Agent 改错了文件或给出错误回复，用户只能手动还原文件或新建会话，成本高且容易残留脏数据。

## What Changes

- **单条消息删除**：允许删除任意一条消息记录（用户消息 / 助手回复 / 工具结果）。为保证发往模型的历史始终合法，删除时自动补删配对消息——删除带 `toolCalls` 的助手消息时级联删除其对应的 `tool` 消息；删除用户消息时级联删除该 turn 内全部后续消息。删除后该内容不再参与后续 LLM 请求，并持久化生效。
- **用户输入回滚（turn 回滚）**：仅用户消息可回滚。回滚 = 截断到该 turn：删除该用户消息及其之后的所有消息，将该用户输入对应的全部文件改动复原（基于新增的持久化回滚快照），并把这句用户输入回填到输入框，供用户修改后重新发送。
- **持久化文件回滚快照**：写文件类工具（`code_edit` / `fs_write_file` / `fs_delete_file` / `fs_move_file`）执行成功时，记录改动前的文件内容或删除副本到本地持久化存储，按「会话 + 用户输入 turn」组织；回滚时按 turn 逆序恢复。`terminal` 与 `git` 工具产生的文件改动不纳入回滚覆盖范围。
- **UI 入口**：每条消息 hover 显示「删除」按钮；用户消息额外显示「回滚」按钮（回滚后回填输入框并刷新消息列表）。操作经 webview ↔ 扩展消息协议下发到宿主持久化执行。

## Capabilities

### New Capabilities

- `conversation-delete-rollback`: 对话内容的单条消息删除与用户输入 turn 回滚，包括消息配对补删、按 turn 的消息截断、文件改动回滚快照的持久化与恢复，以及 webview 侧的删除/回滚交互入口。

### Modified Capabilities

- `session-history-storage`: `MessageStore` 接口在既有 `append`/`loadHistory`/`getCompactionPoint`/`clear`/`deleteMessagesAfter`/`updateMessage` 保持不变的前提下，新增「按 seq 精确删除单条消息」与「删除 seq 之后全部消息（供 turn 回滚截断复用）」的接口能力，并同步维护会话索引的 `messageCount` 与 `updatedAt`。
- `session-history-view`: 对话面板在既有「历史会话下拉/整会话删除」基础上，新增对话内逐条消息的「删除」入口与用户消息的「回滚」入口及其交互行为。

## Impact

- **消息存储**：`src/memory/messageStore.ts`、`src/memory/sessionFileStore.ts` —— 新增单条消息删除 API 与按 seq 范围删除，并联动 JSONL 重写与索引更新。
- **回滚快照**：新增本地持久化存储模块（类比 `toolExecutionJournal`），记录写文件工具的 before 内容 / 删除副本，按 `sessionId + turn` 组织，随回滚清理。
- **工具层**：`src/tools/code/editFile.ts`、`src/tools/fs/writeFile.ts`、`src/tools/fs/deleteFile.ts`、`src/tools/fs/moveFile.ts` —— 执行成功时记录回滚快照；`src/core/toolRouter.ts` 或 `AgentLoop` 负责把工具执行关联到当前用户输入 turn（复用 `runId`）。
- **Agent Loop**：`src/agent/agentLoop.ts` —— 将本次 run 的 `runId`/用户消息 seq 关联到 turn，供回滚快照定位。
- **会话管理 / 宿主**：`src/core/localSessionManager.ts`、`src/extension.ts` —— 暴露删除消息与回滚 turn 的命令处理。
- **UI**：`src/chatPanel.ts` 消息协议（`src/webview-ui/protocol.ts`）新增 `deleteMessage` / `rollbackTurn` 命令与回推刷新；`src/webview-ui/` 渲染层把现有本地删除逻辑改为调用宿主并新增回滚按钮与输入框回填。
- **无新外部依赖**；不改变既有工具的对外契约语义，仅额外记录回滚快照。
