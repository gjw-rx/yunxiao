## MODIFIED Requirements

### Requirement: 活跃任务持续进入模型上下文

系统 SHALL 使当前会话的活跃任务在模型请求中可见，同时 MUST NOT 在每个 AgentLoop 请求中、完整会话历史之前无条件插入随 `todo_write` 状态变化的任务 system 消息。成功的 `todo_write` 工具调用及其结果仍在有效历史中时，系统 SHALL 将该结果视为最新任务状态，并 SHALL 不重复注入活跃任务上下文。系统 SHALL 仅在有效历史和当前压缩检查点均不包含与持久化任务快照一致的模型可见任务状态、且存在 `pending` 或 `in_progress` 任务时，注入临时活跃任务上下文。临时上下文 MUST NOT 写入消息历史，且 SHALL 参与请求 token 估算与自动压缩判定。

#### Scenario: 连续完成任务不改变历史前的任务前缀

- **WHEN** 模型成功调用 `todo_write` 将当前任务标记为 `completed`，并将下一项标记为 `in_progress`
- **THEN** 下一次模型请求 SHALL 通过该次工具结果获得新任务状态，且 SHALL 不在完整历史之前新增或替换活跃任务 system 消息

#### Scenario: 活跃任务在模型可见历史中丢失时恢复

- **WHEN** 会话存在 `pending` 或 `in_progress` 任务，但有效历史和当前压缩检查点均不含与持久化快照一致的任务状态
- **THEN** 下一次模型请求 SHALL 包含仅含活跃任务的临时 system 上下文，且该上下文 SHALL 不写入聊天历史

#### Scenario: 已完成或取消任务不触发恢复

- **WHEN** 持久化任务快照不含 `pending` 或 `in_progress` 任务
- **THEN** 系统 SHALL 不注入临时活跃任务上下文

#### Scenario: 压缩后任务状态不丢失

- **WHEN** 会话发生上下文压缩且当前任务列表仍含待办或进行中项
- **THEN** 压缩后的下一次模型请求 SHALL 从压缩检查点上下文获得这些活跃任务，且聊天历史中 SHALL 不新增合成任务消息
