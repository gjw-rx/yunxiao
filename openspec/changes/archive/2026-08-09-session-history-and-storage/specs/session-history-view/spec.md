# session-history-view Specification

## ADDED Requirements

### Requirement: 侧边栏历史会话列表
扩展 SHALL 在 activity bar 提供「历史」视图（`yunxiaoAgent.historyView`，TreeView），列出当前 workspace 的全部会话，按最近更新时间降序排列；每个节点显示会话标题、相对时间与消息数；会话为空时显示空状态提示。视图数据变更（新建/追加/删除/重命名）后 SHALL 自动刷新。

#### Scenario: 展示会话列表
- **WHEN** 当前 workspace 存在 3 个会话（更新时间不同）
- **THEN** 历史视图显示 3 个节点，按 `updatedAt` 降序排列，每个节点含标题、相对时间与消息数

#### Scenario: 无会话时显示空状态
- **WHEN** 当前 workspace 尚无任何会话
- **THEN** 历史视图显示空状态文案，不报错

### Requirement: 回放历史会话
用户点击历史视图中的会话节点时，系统 SHALL 打开对话面板并加载该会话的全部历史消息（用户消息、助手回复、折叠展示的工具调用、token 消耗），供只读回放。

#### Scenario: 点击会话加载历史
- **WHEN** 用户在历史视图点击会话 `s1`
- **THEN** 对话面板切换为 `s1` 并渲染其历史消息，前端 `currentSessionId` 更新为 `s1`

### Requirement: 继续历史会话
系统 SHALL 支持对历史会话继续对话（resume）：将 `currentSessionId` 切换为目标会话后，`AgentLoop.run` SHALL 从存储加载该会话完整历史（含 compaction 检查点）作为上下文，新消息 SHALL 追加到该会话文件。

#### Scenario: 继续历史会话发消息
- **WHEN** 用户通过历史视图打开会话 `s1` 后发送新消息
- **THEN** 新消息及后续往返追加到 `s1.jsonl`，LLM 上下文包含 `s1` 既有历史

### Requirement: 删除历史会话
用户右键历史会话节点选择删除时，系统 SHALL 弹出确认提示，确认后删除该会话的 JSONL 文件与索引条目，并刷新视图。

#### Scenario: 确认后删除
- **WHEN** 用户确认删除会话 `s1`
- **THEN** `s1.jsonl` 与索引条目被移除，历史视图不再显示 `s1`

#### Scenario: 取消删除
- **WHEN** 用户取消删除确认
- **THEN** 会话数据保持不变
