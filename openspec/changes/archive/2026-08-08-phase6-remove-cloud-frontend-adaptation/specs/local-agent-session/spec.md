## ADDED Requirements

### Requirement: Local session lifecycle management
The `LocalSessionManager` SHALL maintain a mapping of `sessionId` to `AgentLoop` instance. It SHALL create a new `AgentLoop` (or reuse a shared one) when a session is started, delegate `sendMessage(sessionId, text)` to `AgentLoop.run(sessionId, text)`, and delegate `cancel(sessionId)` to `AgentLoop.cancel()`. It SHALL generate unique session IDs using a UUID or timestamp-based scheme.

#### Scenario: Send message delegates to AgentLoop
- **WHEN** `sendMessage('session-1', 'hello')` is called
- **THEN** the LocalSessionManager calls `agentLoop.run('session-1', 'hello')` which appends the user message to MessageStore and enters the Agent Loop

#### Scenario: Cancel delegates to AgentLoop
- **WHEN** `cancel('session-1')` is called while AgentLoop is running
- **THEN** the LocalSessionManager calls `agentLoop.cancel()` which aborts the current LLM stream and pending tool calls

#### Scenario: New session creates fresh state
- **WHEN** a new session is created
- **THEN** the LocalSessionManager generates a unique session ID and returns it for the frontend to use in subsequent messages

### Requirement: Local history loading
The `LocalSessionManager` SHALL load conversation history from `MessageStore` (not from a cloud API). When the frontend requests history for a session, it SHALL return `Message[]` from `MessageStore.loadHistory(sessionId)`, converted to the frontend format `{role, content}` pairs, filtering out `system` and `compaction` messages.

#### Scenario: Load history returns user and assistant messages
- **WHEN** `loadHistory('session-1')` is called and MessageStore contains system, user, and assistant messages
- **THEN** the result includes only user and assistant messages with their content, excluding system prompts and compaction checkpoints

#### Scenario: Load empty history
- **WHEN** `loadHistory('new-session')` is called for a session with no messages
- **THEN** an empty array is returned

### Requirement: Session reset clears local state
The `LocalSessionManager` SHALL clear the `MessageStore` for a session when it is reset. It SHALL cancel any in-flight `AgentLoop` for that session before clearing.

#### Scenario: Reset cancels and clears
- **WHEN** `reset('session-1')` is called while AgentLoop is running
- **THEN** the AgentLoop is cancelled and `MessageStore.clear('session-1')` is called
