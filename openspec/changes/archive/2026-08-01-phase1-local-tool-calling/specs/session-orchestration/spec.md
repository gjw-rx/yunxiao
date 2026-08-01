## ADDED Requirements

### Requirement: Session state tracking
The session manager SHALL maintain, per `sessionId`, the state needed to coordinate multi-round tool-calling: the active `AbortController`, the in-flight tool calls ( keyed by `call_id` with status pending/running/success/error), and a reference to recent message history. State for a session SHALL be removed when the session ends or is reset.

#### Scenario: State created on first stream
- **WHEN** a user message starts streaming for a session that has no state yet
- **THEN** the session manager creates an entry with a fresh `AbortController` and an empty pending-tool-call map

#### Scenario: State removed on session reset
- **WHEN** the user starts a new session (or the session is invalidated)
- **THEN** the previous session's state (abort controller, pending calls) is cleared

### Requirement: Multi-round SSE continuation
A single user message MAY trigger multiple SSE streams: when the cloud emits a `tool_call` event the current stream ends, the local tool executes, its result is posted via `/tool_result`, and the cloud responds with a new SSE stream that the session manager SHALL attach to the same session. The session manager SHALL treat both "user sends message" and "tool result posted" as entry points that start a new SSE stream for the session.

#### Scenario: Tool call triggers continuation
- **WHEN** the cloud stream emits a `tool_call` for `fs.read_file` and then ends
- **THEN** the session manager executes the local tool, posts the result via `/tool_result`, and attaches the cloud's continuation stream to the same session

#### Scenario: Multiple sequential tool calls in one turn
- **WHEN** the agent issues tool call A, then after its result another tool call B, before producing a final answer
- **THEN** the session manager runs two continuation rounds (A then B), each as a distinct SSE stream, all under the same session

### Requirement: Tool call lifecycle
The session manager SHALL track each tool call through `pending` -> `running` -> `success` | `error` states. The current state SHALL be queryable so the UI can render tool-call status. A tool call that errors SHALL still produce a `tool_result` with `status: 'error'` so the cloud can adjust its strategy.

#### Scenario: Successful tool call transitions to success
- **WHEN** `fs.read_file` executes and returns content
- **THEN** the call's state becomes `success` and a success `tool_result` is posted

#### Scenario: Failed tool call posts error result
- **WHEN** `fs.read_file` fails (e.g. file not found)
- **THEN** the call's state becomes `error` and a `tool_result` with `status: 'error'` and the reason is posted, so the agent can recover

### Requirement: Cancel and abort
The session manager SHALL support cancelling an in-flight turn: aborting the active SSE stream AND any running local tool execution. On cancel, the session manager SHALL post a `tool_result` with `status: 'cancelled'` for any pending/running tool call so the cloud does not wait indefinitely, then end the turn locally.

#### Scenario: User stops during tool execution
- **WHEN** the user presses stop while `fs.read_file` is running
- **THEN** the tool execution is aborted, a `cancelled` tool_result is posted for that call, and the UI returns to the idle state

#### Scenario: User stops during streaming
- **WHEN** the user presses stop while a content stream is in progress and no tool call is pending
- **THEN** the stream is aborted and the UI returns to idle; no tool_result is posted

### Requirement: Tool execution timeout
The session manager SHALL enforce a timeout on local tool execution (default 30 seconds, configurable). When a tool exceeds the timeout, the session manager SHALL abort it and post a `tool_result` with `status: 'error'` indicating timeout.

#### Scenario: Tool exceeds timeout
- **WHEN** a local tool runs longer than the configured timeout
- **THEN** the session manager aborts the tool and posts an error tool_result with a timeout reason
