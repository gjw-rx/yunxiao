## MODIFIED Requirements

### Requirement: Local session lifecycle management
The `LocalSessionManager` SHALL maintain a mapping of `sessionId` to `AgentLoop` instance. It SHALL create a new `AgentLoop` (or reuse a shared one) when a session is started, delegate `sendMessage(sessionId, text)` to `AgentLoop.run(sessionId, text)`, and delegate `cancel(sessionId)` to `AgentLoop.cancel()`. It SHALL generate unique session IDs using a UUID or timestamp-based scheme. The `AgentLoop.run()` SHALL initialize a fresh `ToolCallTracker` and `ToolResultCache` per invocation.

#### Scenario: Send message delegates to AgentLoop
- **WHEN** `sendMessage('session-1', 'hello')` is called
- **THEN** the LocalSessionManager calls `agentLoop.run('session-1', 'hello')` which appends the user message to MessageStore and enters the Agent Loop with fresh tracker and cache instances

#### Scenario: Cancel delegates to AgentLoop
- **WHEN** `cancel('session-1')` is called while AgentLoop is running
- **THEN** the LocalSessionManager calls `agentLoop.cancel()` which aborts the current LLM stream and pending tool calls

#### Scenario: New session creates fresh state
- **WHEN** a new session is created
- **THEN** the LocalSessionManager generates a unique session ID and returns it for the frontend to use in subsequent messages

### Requirement: AgentLoop SHALL check repeat and cache before executing tools
Before executing each tool call, the AgentLoop SHALL check the `ToolResultCache` for read-only tools. On cache hit, it SHALL return the cached result without executing. After cache miss, the AgentLoop SHALL check the `ToolCallTracker` for consecutive repeats. If the repeat threshold is reached, the AgentLoop SHALL inject a guidance message and skip execution. Otherwise, the tool SHALL be executed and the result cached (for read tools).

#### Scenario: Cache hit on read tool
- **WHEN** a read tool is called with arguments that match a cached entry
- **THEN** the cached result SHALL be returned with `[cached]` prefix, and the tool SHALL NOT be executed

#### Scenario: Repeat threshold reached
- **WHEN** the same tool with identical arguments is called for the third consecutive time
- **THEN** a guidance message SHALL be injected and the tool SHALL NOT be executed

#### Scenario: Normal execution on first call
- **WHEN** a tool is called for the first time (or with different arguments) in the current run
- **THEN** the tool SHALL be executed normally and the result SHALL be cached if it is a read tool

---

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
