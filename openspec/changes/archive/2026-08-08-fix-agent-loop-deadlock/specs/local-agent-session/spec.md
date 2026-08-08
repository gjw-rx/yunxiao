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
