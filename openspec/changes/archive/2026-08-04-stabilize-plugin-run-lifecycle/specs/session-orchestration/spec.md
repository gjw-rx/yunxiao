## MODIFIED Requirements

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

## ADDED Requirements

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
