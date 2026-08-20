## Why

当前会话虽以 JSONL 保存消息，但其数据模型仍是可重写的线性列表：删除、回滚、token 回写和 1000 条上限都会改变或丢失历史；异步落盘也没有可供 AgentLoop 判断的提交成功边界。这使会话只能“读取聊天记录”，不能作为可审计、可恢复的长期归档。

现在需要先补齐可靠归档底座，使后续会话树、从历史重试、导入导出等能力建立在稳定的数据契约上，而不是继续扩展现有可变消息文件。

## What Changes

- 引入版本化、追加式的会话归档记录格式，提供稳定的会话 header、记录 ID、父引用、物理记录序号和活动会话位置。
- 将原始归档、活动分支投影和 LLM 上下文投影分离；历史消息不再因 UI 或上下文上限而从归档中删除。
- 为用户消息、最终 assistant 消息和工具结果建立可等待的归档提交语义；运行完成状态不得先于相应最终记录的提交成功。
- 使会话索引成为可从归档重建的加速视图，并定义损坏、旧格式和迁移处理。
- 将上下文压缩检查点改为引用保留边界，而非持有近期消息副本；压缩后的上下文仍可从活动路径确定性重建。
- 将“从历史继续”和“永久删除”预留为不同的数据语义：本 change 建立活动位置和不可变记录基础，保留永久删除的物理清理要求。

## Capabilities

### New Capabilities

- `durable-session-archive`: 定义版本化追加式会话归档、活动位置、提交确认、索引重建和旧会话迁移的基础契约。

### Modified Capabilities

- `session-history-storage`: 会话消息存储从可变线性 JSONL 扩展为可恢复的归档记录和投影。
- `context-compaction`: 压缩检查点改为基于归档 Entry 边界重建有效上下文。
- `conversation-delete-rollback`: 回滚和永久删除在不可变归档下采用明确且不同的持久化语义。

## Impact

- 主要影响 `src/memory/sessionFileStore.ts`、`src/memory/messageStore.ts`、`src/memory/types.ts`、`src/memory/historyLoader.ts`、`src/agent/compaction.ts`、`src/agent/agentLoop.ts` 与扩展停用流程。
- 会话 JSONL 产生新版本；既有裸消息 JSONL 需要兼容读取并受控迁移。
- `MessageStore` 对 AgentLoop、聊天面板和既有测试的兼容门面需要保留或有明确迁移路径。
- 不新增外部服务或数据库依赖；本 change 不实现树形 UI、fork、导入导出、HTML 查看器或实时事件回放。
