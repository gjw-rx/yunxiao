# session-history-storage Specification

## Purpose

定义 VS Code 插件会话消息、会话索引和任务快照在本地文件中的持久化、恢复、工作区隔离、兼容迁移与删除清理行为。

## ADDED Requirements

### Requirement: 单条消息删除与 turn 截断的持久化
`MessageStore` SHALL 新增 `deleteMessage(sessionId, seq)` 接口，按被删消息角色补删配对消息（用户消息级联整个 turn、带 `toolCalls` 的助手消息级联其工具结果、工具结果同步清理孤立 `toolCalls`）。删除操作 SHALL 通过 JSONL 整体重写持久化，并 SHALL 同步更新会话索引的 `messageCount` 与 `updatedAt`。既有的 `append`/`loadHistory`/`getCompactionPoint`/`clear`/`deleteMessagesAfter`/`updateMessage` 接口签名 SHALL 保持不变。

#### Scenario: 删除后 JSONL 与索引一致
- **WHEN** 会话 `s1` 有 6 条消息，删除 seq=3 的用户消息（级联删除 seq 3 至 5）
- **THEN** `s1.jsonl` 只保留 seq 0 至 2 的消息，索引中 `s1.messageCount` 更新为 3，`updatedAt` 刷新

#### Scenario: 删除不存在的 seq 为无操作
- **WHEN** 对不存在的 seq 调用 `deleteMessage`
- **THEN** 消息与索引均不变，不抛异常
