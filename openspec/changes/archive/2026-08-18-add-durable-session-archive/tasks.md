## 1. 归档契约与投影基础

- [x] 1.1 在 `src/memory/types.ts` 定义版本化 SessionRecord、session header、Entry、compaction 边界和活动位置记录的严格 TypeScript 契约，并保留 Message 的兼容投影类型。
- [x] 1.2 新建会话归档 repository/parser，支持按 workspace 读取完整归档、验证 header/ID/父链/活动位置，并为有效记录建立 ID 与物理序号索引。
- [x] 1.3 实现完整归档、活动路径和 LLM 上下文的独立投影；确保非活动路径不进入 MessageStore 或 HistoryLoader 的兼容读取结果。
- [x] 1.4 为 v2 header、追加 Entry、活动位置跨重启、父链循环、重复 ID、悬挂父引用和损坏 compaction 边界编写单元测试。

## 2. 持久化提交、索引与迁移

- [x] 2.1 将 `SessionFileStore` 的排队写入改为可等待且可拒绝的提交接口，保留每会话写入顺序，并让失败返回调用方而非仅记录日志。
- [x] 2.2 新会话首次接受用户消息时原子写入 v2 header 与首个 Entry；移除归档层的 `MAX_MESSAGES` 截断，保留永久删除时的显式重写路径。
- [x] 2.3 将 `index.json` 改为可重建缓存，支持从合法归档扫描恢复会话元数据和活动位置，并为索引缺失、损坏和孤儿归档编写测试。
- [x] 2.4 实现旧裸 Message JSONL 的双读与惰性迁移：临时文件、完整结构校验、原文件备份、原子替换和失败只读回退。
- [x] 2.5 扩展迁移测试，覆盖旧 workspaceState、旧 JSONL 成功迁移、迁移失败不覆盖源文件及重启后的线性历史一致性。

## 3. 现有会话流程集成

- [x] 3.1 将 `MessageStore` 改为使用归档 repository，同时保留 `append`、`loadHistory`、删除和 token 更新调用方所需的兼容门面与稳定 `seq` 投影。
- [x] 3.2 调整 `HistoryLoader` 只消费活动路径的压缩感知投影，并阻止包含不完整工具配对或归档损坏的上下文进入 LLM 请求。
- [x] 3.3 将 `CompactionMessage.recentContext` 迁移为 `firstKeptEntryId` 边界；更新尾部选择逻辑，使工具调用和结果保持完整且不修改历史 Message Entry。
- [x] 3.4 调整 `AgentLoop`：模型调用前确认用户消息归档提交，最终 assistant/tool 结果提交后才发布运行终态；归档失败时发布可定位失败状态。
- [x] 3.5 调整 `LocalSessionManager.rollbackTurn`：恢复工作区后持久化活动位置到目标 turn 之前，保留原始归档 Entry，并保持输入回填行为。
- [x] 3.6 调整扩展停用流程，等待所有待提交会话记录结算，并记录包含 sessionId、recordSeq 和失败原因的中文日志。

## 4. 回归验证与发布准备

- [x] 4.1 更新 `session-history-storage`、`context-compaction` 和 `conversation-delete-rollback` 相关单元测试，覆盖本 change 的所有新增和修改场景。
- [x] 4.2 验证永久删除仍会物理清理目标会话消息及关联 rollback/change 资产，而回滚仅改变活动投影并保留归档。
- [x] 4.3 运行 `npm run compile`，修复本 change 引入的类型和 lint 问题。
- [x] 4.4 运行 `npm test`，验证旧会话迁移、重启恢复、压缩、回滚和现有聊天历史回归通过。
