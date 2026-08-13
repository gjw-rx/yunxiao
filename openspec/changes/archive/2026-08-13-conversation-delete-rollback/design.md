# Design: 对话内容删除与回滚

## Context

当前插件仅支持「整会话删除」（`session-history-view`）。前端 `MessageList` 已有 hover 删除按钮，但只调用 reducer 的本地状态过滤（`deleteUserMessage`/`deleteAssistantMessage`，`reducer.ts:553-568`），既不通知扩展宿主，也不持久化。

后端 `MessageStore` 只有 `deleteMessagesAfter(sessionId, seq)`（`messageStore.ts:139-155`，截断 seq 之后），无单条删除 API。消息以 `(sessionId, seq)` 唯一标识，`seq` 递增分配；`AgentLoop` 每轮从 `MessageStore` 重载历史再拼给 LLM，删除后自然不再下发，无需额外缓存失效。

文件改动无任何可回滚依据：`fs_write_file` 覆盖不保留旧内容（`writeFile.ts:73-91`），`fs_delete_file` 走回收站（`deleteFile.ts:33-46`），`code_edit` 的 before 快照只写系统临时目录且 1 小时后清理（`editFile.ts:163-299`），`ToolExecutionJournal` 只存执行回执不存文件内容（`toolExecutionJournal.ts`）。

关键约束：`session-history-storage` 明确要求 `MessageStore` 对外接口（`append`/`loadHistory`/`getCompactionPoint`/`clear`/`deleteMessagesAfter`/`updateMessage`）保持不变——本设计只**新增**方法，不改既有签名。

## Goals / Non-Goals

**Goals:**

- 删除任意单条消息记录，且后续 LLM 请求不再包含它，持久化生效。
- 删除时保证发往模型的历史始终合法（OpenAI 兼容 API 要求 `tool` 消息紧跟其 `assistant.toolCalls` 应答）。
- 回滚某个用户输入 turn：文件改动复原、该 turn 及之后的消息截断删除、用户输入回填输入框。
- 回滚的文件恢复基于新增的**持久化 before 快照**，不依赖 git。

**Non-Goals:**

- 不覆盖 `terminal` / `git` 工具产生的文件改动（无法可靠追踪，见 Risks）。
- 不改动既有 `MessageStore` 方法签名，不改动既有工具的对外契约语义（仅额外记录快照）。
- 不引入新的外部依赖。
- 不修复前端「系统注入消息被渲染成用户消息」这一既有展示问题（仅新增 `injected` 标记供后端判定 turn 边界，前端渲染行为保持现状）。

## Decisions

### D1: 用后端 `seq` 作为删除/回滚的定位键

前端消息 `id` 是渲染期自增（`nextId`），与后端无映射。因此：

- `HistoryEntry`（`localSessionManager.ts` 与 `protocol.ts`）新增 `seq` 字段，随 `historyLoaded` 下发给前端。
- 前端 `MessageItem` 新增 `seq`，删除/回滚按钮把 `{ sessionId, seq }` 通过新命令 `deleteMessage` / `rollbackTurn` 发给宿主。
- 宿主处理完成后回推新的 `historyLoaded` 让前端整体重建，前端**不**在本地重复实现级联/恢复逻辑。

> 备选：前端按 `turn` 索引定位。被否决——`turn` 是前端重建的派生值，且系统注入的 user 消息会打乱计数，不可靠。

### D2: 删除的配对补删语义（保证历史合法）

`MessageStore.deleteMessage(sessionId, seq)` 按被删消息的 role 决定级联范围：

- **删 user（seq=X）**：级联删除 X 及其后、下一条「真实用户消息」之前的所有消息（整个 turn）。为识别真实用户输入，`UserMessage` 新增可选 `injected?: boolean`，`AgentLoop` 注入的 `MAX_STEPS_PROMPT` / `EMPTY_REPLY_PROMPT` / doom 引导消息标记 `injected: true`，真实输入缺省为 false。
- **删带 `toolCalls` 的 assistant（seq=Y）**：删除 Y 及其 `toolCalls[].id` 对应的所有 `tool` 消息（`toolCallId` 匹配）。
- **删 `tool`（seq=Z）**：删除 Z，并同步从对应 `assistant.toolCalls` 中移除 `toolCallId === Z.toolCallId` 的条目；若移除后该 assistant 无 `toolCalls` 且正文为空，则一并删除该 assistant 消息，避免孤立 toolCall 导致后续请求被 API 拒绝。
- **删普通 assistant（无 toolCalls）**：仅删该条。
- **删 compaction**：仅删该条。

> 备选：纯物理删单条、不做任何配对。被否决——会留下无应答 `toolCalls` 或孤立 `tool` 消息，OpenAI 兼容 API 可能返回 400。

### D3: 回滚 = 截断到该 turn + 文件恢复到该 turn 前

回滚 user（seq=X）等价于「回到 X 之前」：

1. 文件恢复：收集所有 `userSeq >= X` 的回滚快照条目，按文件路径取「X 之后第一次改动前」的状态恢复工作区文件（原本不存在的文件则删除），然后清理这些快照。
2. 消息截断：`MessageStore.deleteMessagesAfter(sessionId, X - 1)`，删除 X 及之后全部消息。
3. 输入回填：宿主把 X 的 `content` 经新命令 `rollbackRestored { text }` 回推，前端写入输入框。

> 备选：只回滚该 turn 而保留其后 turn。被否决（用户已确认）——后续 turn 可能依赖已回滚的文件，状态会不一致。

### D4: 回滚快照 = before 文件副本到本地暂存目录

新增 `RollbackJournal`（持久化，类比 `ToolExecutionJournal`），暂存目录 `~/.yunForce/projects/<ws 编码>/rollback/<sessionId>/<userSeq>/`：

- **记录时机**：写文件类工具（`code_edit` / `fs_write_file` / `fs_delete_file` / `fs_move_file`）执行成功前，把目标路径的 before 状态复制进暂存目录（文件 `fs.cp` 递归复制；目录删除亦用递归复制，回滚时整目录还原）。
- **变更条目**：记录 `{ userSeq, relativePath, existedBefore }`——`existedBefore=false` 表示该文件为 turn 内新建，回滚时应删除。
- **turn 关联**：`ToolContext` 新增可选 `turnUserSeq`，`AgentLoop.buildToolContext` 传入本次 run 的 `userMessage.seq`（`agentLoop.ts:158-159`）。同一 run 内所有工具调用均归属该 userSeq。
- **清理**：turn 被回滚时删除该 turn 及之后快照；删除会话时一并删除该会话快照目录；与消息截断联动，`userSeq >= X` 的快照随截断清理。

> 备选 1：复用 git stash/checkout。被否决——依赖 git 仓库，无法覆盖非 git 文件与新建文件。备选 2：把 before 内容以字符串存进 workspaceState。被否决——不覆盖二进制文件与目录，且 workspaceState 有体积与性能顾虑。

### D5: 文件恢复绕过工具审批

回滚是用户显式触发的撤销操作，恢复文件时由 `RollbackJournal` 直接 `fs` 写回工作区（经 `pathGuard.resolveWithinRoots` 校验暂存路径映射），**不**走 `ToolRouter`/审批网关，避免二次弹窗。

### D6: 宿主命令与 UI 入口

- `protocol.ts` 新增 `WebviewToHostMessage`：`deleteMessage { sessionId, seq }`、`rollbackTurn { sessionId, seq }`；新增 `HostToWebviewMessage`：`rollbackRestored { text }`。
- `chatPanel._handleMessage` 新增两分支：调 `LocalSessionManager.deleteMessage` / `rollbackTurn`，处理后回推 `historyLoaded`（刷新）与 `rollbackRestored`（回填）。
- `MessageList.tsx`：每条消息 hover 显示「删除」；user 消息额外显示「回滚」。按钮回调由 reducer 本地过滤改为 `post` 新命令。
- 回滚需要用户确认（`showWarningMessage`，因其删除消息 + 改动文件、不可恢复），删除单条消息无需确认。

## Risks / Trade-offs

- **[删除 `tool` 消息改变 assistant.toolCalls 结构]** → 按 D2 同步清理孤立 toolCall；若 assistant 变空则整体删除，保证历史仍合法。
- **[`terminal` / `git` 工具的文件改动无法回滚]** → 明确 non-goal；UI 在回滚确认文案中提示「终端/Git 产生的改动需手动还原」。
- **[回滚快照占用磁盘]** → 快照随 turn 回滚/会话删除/消息截断清理；对长期不清理的历史，`RollbackJournal` 在会话删除时兜底清空，暂存目录按 workspace 隔离。
- **[系统注入 user 消息破坏 turn 边界]** → `injected` 标记（D2）使后端按「非 injected 的 user 消息」判定真实 turn；前端展示维持现状。
- **[并发/流式进行中的删除]** → 删除/回滚仅作用于已持久化消息；若目标会话正在 `AgentLoop.run`，宿主先拒绝或复用现有取消路径，避免流式写入与截断竞态（见 tasks 中对该竞态的测试项）。

## Migration Plan

- 无存量数据迁移：新增字段（`UserMessage.injected`、`HistoryEntry.seq`、`MessageItem.seq`）均为可选，旧 JSONL 消息缺省按 `injected=false`、`seq` 已有值处理。
- 回滚快照为新目录，旧会话无快照时回滚仅执行消息截断 + 输入回填，文件恢复为空操作（并提示）。
- 纯增量，无破坏性变更，`npm run compile`（check-types + lint）通过即视为可合并。

## Open Questions

- 删除单条消息是否需要二次确认？（当前默认：删除无需确认，回滚需确认。）
- 回滚快照目录是否需要磁盘上限/定期清理策略？（当前默认：随会话删除兜底清理，不设上限。）
