## ADDED Requirements

### Requirement: 模型可全量写入会话任务列表
系统 SHALL 向模型注册本地 `todo_write` 工具。该工具 SHALL 接受必填的有序 `todos` 数组；每项 SHALL 包含非空且唯一的 `id`、非空 `content` 与 `status`，其中 `status` MUST 为 `pending`、`in_progress`、`completed` 或 `cancelled`。一次调用 SHALL 原子替换当前会话的整个任务列表，列表中 MUST 至多包含一项 `in_progress`。工具 SHALL 返回规范化后的完整列表及各状态计数，且 SHALL 不触发用户审批。

#### Scenario: 模型建立任务计划
- **WHEN** 模型调用 `todo_write` 并传入三个有效任务，其中一项为 `in_progress`
- **THEN** 系统持久化该顺序列表并向模型返回完整列表及状态计数

#### Scenario: 模型更新完成状态
- **WHEN** 模型以相同任务 ID 调用 `todo_write`，将进行中的任务标记为 `completed` 并将下一项标记为 `in_progress`
- **THEN** 系统以新完整列表替换旧列表，且任务面板显示新的完成状态

#### Scenario: 非法任务写入被拒绝
- **WHEN** 模型传入空任务 ID、非法状态、重复 ID，或多于一项 `in_progress`
- **THEN** 系统 SHALL 返回结构化工具错误且 SHALL 不修改已持久化的任务列表

### Requirement: 任务状态按会话持久化并可恢复
系统 SHALL 将每个会话的最新任务快照作为会话级状态保存。Webview 重新加载、扩展重启或用户打开历史会话时，系统 SHALL 恢复该会话的最新快照。一个会话的任务写入 MUST NOT 改变其他会话的任务状态。

#### Scenario: 重启后恢复任务状态
- **WHEN** 会话已保存包含已完成与待办项的任务列表，随后扩展重启并再次打开该会话
- **THEN** 系统恢复并显示该会话最后一次成功写入的完整任务列表

#### Scenario: 会话之间任务隔离
- **WHEN** 会话 A 与会话 B 分别拥有任务列表，模型更新会话 A 的列表
- **THEN** 会话 B 的列表保持不变

### Requirement: 活跃任务持续进入模型上下文
系统 SHALL 在每个 AgentLoop 请求中加入当前会话的临时任务上下文。该上下文 SHALL 仅包含 `pending` 与 `in_progress` 项，MUST NOT 写入消息历史，并 SHALL 计入请求 token 估算与自动压缩判定。

#### Scenario: 工具调用后的下一步看到新任务状态
- **WHEN** 模型在一个工具步骤中成功调用 `todo_write`
- **THEN** 下一次模型请求包含更新后的未完成任务而不包含已完成或取消的任务

#### Scenario: 压缩后任务状态不丢失
- **WHEN** 会话发生上下文压缩且当前任务列表仍有待办或进行中项
- **THEN** 压缩后的下一次模型请求仍包含这些活跃任务，且聊天历史中不新增合成任务消息

### Requirement: 插件展示当前会话任务进度
系统 SHALL 在聊天 Webview 中展示当前会话的只读、可折叠任务面板。面板 SHALL 显示完成数与总数，并对待办、进行中、完成和取消状态作可区分展示。任务列表全部完成或取消后，面板 SHALL 保留最后快照，直到模型写入空列表或替换列表、用户切换会话，或会话被删除。

#### Scenario: 实时展示任务更新
- **WHEN** `todo_write` 成功写入当前会话的任务列表
- **THEN** Webview 在不重新加载聊天历史的情况下更新任务面板

#### Scenario: 打开历史会话展示任务记录
- **WHEN** 用户打开拥有已完成任务记录的历史会话
- **THEN** Webview 加载该会话任务快照并显示完成状态

#### Scenario: 任务面板折叠
- **WHEN** 用户点击任务面板标题
- **THEN** 面板切换任务行的显示状态，同时保留完成数与总数

### Requirement: 任务状态通过独立事件协议传递
系统 SHALL 为任务快照定义类型化 EventBus 与 Host-to-Webview 消息，并 SHALL 在任务成功写入及加载会话历史时发送该快照。任务状态更新 MUST NOT 作为新的聊天消息、计划时间线条目或工具结果解析副作用来渲染。

#### Scenario: 更新不会新增聊天条目
- **WHEN** 当前会话的任务状态变更
- **THEN** Webview 更新任务面板且消息列表不新增计划或普通聊天条目
