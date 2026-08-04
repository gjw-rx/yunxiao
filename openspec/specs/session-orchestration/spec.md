# session-orchestration Specification

## Purpose
TBD - created by archiving change phase1-local-tool-calling. Update Purpose after archive.
## Requirements
### Requirement: Session state tracking
The session manager SHALL maintain, per `sessionId`, the active run generation, active `AbortController`, in-flight tool calls keyed by `call_id`, recent message state, retry counters, and finalized call ids. Every user-initiated run SHALL receive a manager-lifetime monotonically increasing generation. Every SSE, continuation, tool, timeout, and error callback SHALL verify that its captured generation is still current before reading or mutating session state. State SHALL be removed when the session is reset, and a finalized call id SHALL never produce a second result.

#### Scenario: Late completion is ignored
- **WHEN** a cancelled tool resolves after the session has finalized its call id
- **THEN** the session manager ignores the late completion and does not post a second result

#### Scenario: Previous stream ends after a new run starts
- **WHEN** run generation N is replaced by generation N+1 and the stream for generation N later emits content, an error, a tool call, or an end callback
- **THEN** the session manager ignores that callback and generation N+1 remains unchanged

#### Scenario: Reset session id is reused
- **WHEN** a session is reset, recreated with the same session id, and an asynchronous callback from the deleted state later resolves
- **THEN** the manager-lifetime generation check rejects the stale callback

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
The session manager SHALL support cancelling an in-flight turn by aborting the active SSE stream and all cancellable local tools. It SHALL post one `cancelled` result for each pending/running call that has not already been finalized, then clear the turn state.

#### Scenario: Cancel during multiple calls
- **WHEN** the user stops a turn with multiple local calls pending or running
- **THEN** each unfinished call is finalized once as cancelled and no new local execution starts

### Requirement: Tool execution timeout
The session manager SHALL enforce a configurable timeout on each local tool execution. On timeout it SHALL abort the tool, finalize the call, and post one `error` result containing a timeout reason and `metadata.retryable` set according to the tool's failure classification.

#### Scenario: Timeout cleans state
- **WHEN** a local tool exceeds its configured timeout
- **THEN** the tool is aborted, the call is finalized, the timeout result is posted, and no pending state remains for that call

### Requirement: Agent switching creates an isolated cloud session
When the user selects an Agent different from the one currently bound to the active conversation, the plugin SHALL create a new cloud session for that Agent. It SHALL retain the prior session until creation succeeds, then make the returned session the active conversation and clear the previous session's local orchestration state. Selecting the currently active Agent SHALL NOT create another session.

#### Scenario: Select a different Agent
- **WHEN** a conversation using Agent A is active and the user selects Agent B
- **THEN** the plugin creates a session for Agent B and makes its returned session ID active after the request succeeds

#### Scenario: Re-select the active Agent
- **WHEN** the user selects the Agent already bound to the active conversation
- **THEN** the plugin keeps the active session and does not call the session-creation API

#### Scenario: New session creation fails
- **WHEN** the user selects a different Agent and its session-creation request fails
- **THEN** the plugin preserves the previous active session and reports the error

### Requirement: Explicit local run terminal states
The session manager SHALL expose exactly one terminal outcome for each current local run: `completed`, `cancelled`, `failed`, or `disconnected`. A clean final SSE end with no pending tool calls SHALL produce `completed`; an explicit user cancellation SHALL produce `cancelled`; a server, protocol, or local orchestration error SHALL produce `failed`; and an unexpected transport loss or duplicate acknowledgement without a continuation stream SHALL produce `disconnected`. The legacy `stream_end` event MAY remain for compatibility but SHALL NOT be the source used to infer the terminal outcome.

#### Scenario: Clean stream completes
- **WHEN** the current SSE stream ends cleanly after producing the final response and no local tool calls remain
- **THEN** the run emits one `completed` terminal state

#### Scenario: User cancels current run
- **WHEN** the user cancels the current run
- **THEN** the run emits one `cancelled` terminal state and SHALL NOT later emit `completed`

#### Scenario: Server rejects the run
- **WHEN** the current run receives a server error envelope or a non-recoverable protocol error
- **THEN** the run emits one `failed` terminal state containing a user-readable reason

#### Scenario: Transport disconnects unexpectedly
- **WHEN** the current run loses its network stream without a clean end, explicit cancellation, or server terminal error
- **THEN** the run emits one `disconnected` terminal state and SHALL NOT claim successful completion

#### Scenario: Duplicate result has no continuation
- **WHEN** a tool result submission receives a valid duplicate acknowledgement instead of the original continuation stream
- **THEN** the result is treated as accepted and the local run emits `disconnected` rather than `completed` or `failed`

