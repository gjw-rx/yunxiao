# Tasks: 对话内容删除与回滚

## 1. 消息存储与数据模型

- [x] 1.1 `src/memory/types.ts`：`UserMessage` 新增可选 `injected?: boolean` 字段（标识系统注入消息，含中文注释）
- [x] 1.2 `src/agent/agentLoop.ts`：注入 `MAX_STEPS_PROMPT`、`EMPTY_REPLY_PROMPT`、doom 引导消息时标记 `injected: true`（真实用户输入不标记）
- [x] 1.3 `src/core/localSessionManager.ts` 的 `HistoryEntry` 与 `src/webview-ui/protocol.ts` 的 `HistoryEntry` 增加 `seq` 字段，`loadHistory` 返回时带上 `seq`
- [x] 1.4 `src/memory/messageStore.ts` 新增 `deleteMessage(sessionId, seq)`：按 role 补删配对（删 user 级联整个 turn、删带 `toolCalls` 的 assistant 级联其 tool、删 tool 清理孤立 `toolCalls` 并处理空 assistant），JSONL 整体重写 + 索引 `messageCount`/`updatedAt` 联动
- [x] 1.5 单测 `src/test/memory/messageStore.test.ts`：覆盖删除 user/assistant/tool/compaction、注入消息边界、不存在 seq 无操作

## 2. 回滚快照

- [x] 2.1 新增 `src/core/rollbackJournal.ts`：持久化 before 文件副本到 `~/.yunForce/projects/<ws 编码>/rollback/<sessionId>/<userSeq>/`，提供 `recordFileChange` / `restoreTurn` / `clearAfterSeq` / `clearSession`（中文 JSDoc + 日志）
- [x] 2.2 `src/tools/baseTool.ts` 的 `ToolContext` 新增可选 `turnUserSeq?: number`；`src/agent/agentLoop.ts` 的 `buildToolContext` 传入本次 run 的 `userMessage.seq`
- [x] 2.3 写文件工具执行成功前记录快照：`src/tools/code/editFile.ts`、`src/tools/fs/writeFile.ts`、`src/tools/fs/deleteFile.ts`、`src/tools/fs/moveFile.ts`（通过注入的回滚记录器写入，目标不存在时记为新建）
- [x] 2.4 单测 `src/test/core/rollbackJournal.test.ts`：覆盖覆盖写入、新建、删除、目录、按 seq 清理与会话清理

## 3. 会话管理命令

- [x] 3.1 `src/core/localSessionManager.ts` 新增 `deleteMessage(sessionId, seq)` 与 `rollbackTurn(sessionId, seq)`（恢复文件 → `deleteMessagesAfter(seq-1)` → 清理快照 → 返回被回滚文本）
- [x] 3.2 `src/extension.ts` 装配 `RollbackJournal` 并注入 `LocalSessionManager` 与写文件工具

## 4. 宿主协议处理

- [x] 4.1 `src/chatPanel.ts` `_handleMessage` 新增 `deleteMessage` / `rollbackTurn` 分支：回滚弹 `showWarningMessage` 确认，处理后回推 `historyLoaded` 与 `rollbackRestored { text }`
- [x] 4.2 处理目标会话正在 `AgentLoop.run` 的竞态（拒绝操作或先取消，避免流式写入与截断冲突）

## 5. 前端 UI

- [x] 5.1 `src/webview-ui/protocol.ts` 新增 `deleteMessage` / `rollbackTurn`（WebviewToHost）与 `rollbackRestored`（HostToWebview）命令类型
- [x] 5.2 `src/webview-ui/state/reducer.ts`：`MessageItem` 增加 `seq`，`historyLoaded` 重建时保留 `seq`；删除/回滚 action 改为触发宿主命令（不再本地过滤）
- [x] 5.3 `src/webview-ui/components/chat/MessageList.tsx` 与 `App.tsx`：每条消息 hover 显示「删除」，user 消息额外显示「回滚」，点击 `post` 对应命令
- [x] 5.4 `rollbackRestored` 处理：`src/webview-ui/components/chat/MessageInput.tsx` 回填被回滚文本到输入框

## 6. 验证

- [x] 6.1 更新前端单测 `src/webview-ui/test/reducer.test.ts`：删除/回滚改走命令、`rollbackRestored` 回填输入框
- [x] 6.2 `npm run compile`（check-types + lint）通过，无新增告警
- [x] 6.3 验收：`npm test` 全绿（581 passing）——删除持久化/配对补删（messageStore 单测）、回滚文件恢复/截断/清理（rollbackJournal 单测）、宿主命令链路与取消分支（chatPanel 单测）、输入回填（reducer 单测）均覆盖；真实 VSCode 中的 UI 点击交互（hover 按钮/确认弹窗/回填焦点）待用户手动验收
