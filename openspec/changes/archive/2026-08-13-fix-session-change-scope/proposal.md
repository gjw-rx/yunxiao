## Why

代码变更当前仅从单轮受控写工具收集快照，终端命令执行的 OpenSpec、Git 提交等改动不会被统计，导致实际改动后页面仍显示 0 个文件。

## What Changes

- 将代码变更统计口径改为当前会话的工作区基线差异，而非某一轮回复的工具调用结果。
- 在会话首次执行前持久化可审查文件的基线快照；每个最终回复后重算并更新该会话的累计变更集。
- 保留会话删除和回滚后的清理与重算，确保代码变更页始终反映当前会话的工作区状态。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `session-change-review`: 代码变更的归属与统计维度改为会话级工作区差异。

## Impact

- 修改 `ChangeJournal`、`AgentLoop` 和会话回滚链路。
- 回复与独立代码变更页面继续使用既有协议，但变更集 ID 固定为会话累计变更集。
