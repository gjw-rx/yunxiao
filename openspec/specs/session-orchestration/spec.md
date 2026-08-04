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
A single user message MAY trigger multiple graph computation rounds under one stable cloud `run_id`: when the cloud persists a `tool_call` event, the Run becomes `interrupted`; after the local tool result is posted for that Run, cloud computation resumes in the background. The session manager SHALL persist and consume ordered Run events through a session-owned exclusive sequence cursor and SHALL treat both "user sends message" and "tool result posted" as commands followed by subscription, not as ownership of cloud computation. A reconnect or extension-host restoration SHALL subscribe after the stored cursor and SHALL NOT execute a restored local tool call automatically.

#### Scenario: Tool call triggers continuation
- **WHEN** the cloud Run persists a `tool_call` for `fs.read_file` and becomes `interrupted`
- **THEN** the session manager executes the local tool, posts the result for the same `run_id`, and subscribes after its last consumed sequence

#### Scenario: Multiple sequential tool calls in one turn
- **WHEN** the Run issues tool call A, then after its result another tool call B, before producing a final answer
- **THEN** both continuation commands target the same `run_id`, and the session manager advances one ordered sequence cursor across all rounds

#### Scenario: Subscription disconnects between rounds
- **WHEN** the event subscription disconnects after a tool result command has been accepted
- **THEN** cloud computation continues independently and the session manager can reconnect after its last consumed sequence

#### Scenario: Extension host restores an interrupted Run
- **WHEN** the extension host restarts with an interrupted Run and a stored cursor
- **THEN** the session manager subscribes after that cursor and leaves any stored local tool call pending for user-safe recovery

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
The session manager SHALL expose exactly one terminal outcome for each current local subscription attempt: `completed`, `cancelled`, `failed`, or `disconnected`. A cloud `run_status=completed` event followed by a caught-up stream SHALL produce `completed`; an explicit user cancellation SHALL produce `cancelled`; a cloud failed status, server error, or non-recoverable protocol error SHALL produce `failed`; and an unexpected transport loss before observing a cloud terminal status SHALL produce `disconnected`. A local `disconnected` outcome SHALL NOT imply that the cloud Run stopped or failed.

#### Scenario: Cloud Run completes
- **WHEN** the subscriber receives the cloud Run's `completed` status event and consumes all events through that sequence
- **THEN** the local run emits one `completed` terminal state

#### Scenario: User cancels current subscription
- **WHEN** the user cancels the current local run
- **THEN** the local run emits one `cancelled` terminal state and SHALL NOT infer that cloud computation was cancelled

#### Scenario: Cloud Run fails
- **WHEN** the subscriber receives the cloud Run's `failed` status event
- **THEN** the local run emits one `failed` terminal state containing a user-readable reason

#### Scenario: Transport disconnects unexpectedly
- **WHEN** the current subscription loses its network stream before a cloud terminal status is observed
- **THEN** the local run emits one `disconnected` terminal state and retains its last consumed sequence for replay

#### Scenario: Duplicate result has no continuation response
- **WHEN** a tool result submission receives a valid duplicate acknowledgement rather than owning a continuation stream
- **THEN** the session manager reconnects to the existing `run_id` after its last consumed sequence instead of claiming completion
