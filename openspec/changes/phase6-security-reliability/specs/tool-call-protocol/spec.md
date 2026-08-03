# tool-call-protocol Specification

## MODIFIED Requirements

### Requirement: tool_result HTTP endpoint contract
The cloud SHALL expose `POST /api/agent/invoke/tool_result` accepting a body with `session_id`, `call_id`, `status` (`'success' | 'error' | 'cancelled'`), `result` (string, the tool output or JSON-stringified output), optional `error` (failure reason), and optional `metadata` (`affected_files`, `diff`, `duration_ms`, `retryable`, `truncated`, `redacted`). The cloud SHALL treat `(session_id, call_id)` as an idempotency key, SHALL inject at most one matching tool message, and SHALL return an SSE continuation for the first accepted result. A duplicate submission SHALL return a non-destructive idempotent response and SHALL NOT re-run the agent.

#### Scenario: Cancelled result is not retried
- **WHEN** the plugin posts `status: 'cancelled'` for a denied or aborted call
- **THEN** the cloud injects a matching tool message, resumes the agent once, and does not automatically issue the same call again

#### Scenario: Duplicate result is deduplicated
- **WHEN** the same `session_id` and `call_id` result is posted twice
- **THEN** the cloud does not inject two tool messages or execute two continuations

### Requirement: Stream-interrupt plus HTTP-resume continuation
When the cloud emits a `tool_call` for a local tool, the SSE stream SHALL end after the event. The local plugin SHALL execute the tool and POST the result; the cloud SHALL return a new SSE continuation for the same session. The cloud SHALL preserve the result's `retryable`, `truncated`, and `redacted` metadata for logging and agent context, and SHALL enforce a session-level result budget before injecting the ToolMessage.

#### Scenario: Truncated result is acknowledged
- **WHEN** the plugin posts a result marked `truncated: true`
- **THEN** the cloud injects only the bounded result, records the marker, and the agent can request a narrower follow-up instead of receiving hidden omitted content

### Requirement: tool_result connect-time retry and cancel
The local tool-result submission SHALL retry only connect-time transient failures or failures explicitly classified as retryable, with exponential backoff and a maximum of three attempts. It SHALL NOT retry cancelled, validation, permission, path, or other non-retryable results. The local plugin SHALL support cancelling an in-flight continuation stream via `AbortController`.

#### Scenario: Non-retryable result is submitted once
- **WHEN** a local tool returns a path, permission, or user-cancelled result
- **THEN** the plugin submits it once and does not replay the tool execution
