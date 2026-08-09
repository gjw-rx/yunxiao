# local-agent-session Specification (delta)

## ADDED Requirements

### Requirement: 会话列表与删除接口
`LocalSessionManager` SHALL 提供 `listSessions()` 返回当前 workspace 全部会话的元数据列表（sessionId、标题、createdAt、updatedAt、messageCount），按 `updatedAt` 降序；提供 `deleteSession(sessionId)` 删除指定会话（取消其进行中的 AgentLoop、删除 JSONL 文件与索引条目）。

#### Scenario: 列出全部会话
- **WHEN** 调用 `listSessions()` 且存在会话 `s1`、`s2`
- **THEN** 返回按 `updatedAt` 降序排列的两个会话元数据

#### Scenario: 删除会话
- **WHEN** 调用 `deleteSession('s1')`
- **THEN** `s1` 的存储文件与索引条目被删除，`listSessions()` 不再返回 `s1`

### Requirement: 会话标题维护
`LocalSessionManager` SHALL 在追加首条用户消息时为会话生成默认标题（内容去除空白后截断至 40 字符）；`renameSession` 设置的自定义名称 SHALL 持久化到会话索引并优先于默认标题展示。

#### Scenario: 默认标题
- **WHEN** 会话 `s1` 追加首条用户消息
- **THEN** 会话元数据标题为该消息截断文本，历史视图与列表展示该标题
