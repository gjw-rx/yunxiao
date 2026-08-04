# session-orchestration Specification

## MODIFIED Requirements

### Requirement: Session state tracking
The session manager SHALL maintain, per `sessionId`, the active `AbortController`, in-flight tool calls keyed by `call_id`, recent message state, retry counters, and finalized call ids. State SHALL be removed when the session ends or is reset, and a finalized call id SHALL never produce a second result.

#### Scenario: Late completion is ignored
- **WHEN** a cancelled tool resolves after the session has finalized its call id
- **THEN** the session manager ignores the late completion and does not post a second result

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
