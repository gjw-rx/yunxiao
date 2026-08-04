# tool-call-protocol Specification

## Purpose
TBD - created by archiving change phase1-local-tool-calling. Update Purpose after archive.
## Requirements
### Requirement: tool_call SSE event
The cloud SHALL emit a new `tool_call` SSE event when the agent decides to invoke a tool whose `site` is `local`. The event payload SHALL conform to the existing SSE envelope (`{ type, data }`) and the `data` SHALL contain `call_id` (unique id), `tool` (namespaced name, e.g. `fs.read_file`), `args` (JSON object matching the tool's parameter schema), `site` (`'local' | 'cloud'`), and an optional `require_approval` boolean (default false). The local plugin SHALL parse this event and dispatch it to the local tool registry.

#### Scenario: Cloud requests a local read
- **WHEN** the agent decides it needs to read a local file
- **THEN** the cloud emits `{ type: 'tool_call', data: { call_id: 'c1', tool: 'fs.read_file', args: { path: 'src/extension.ts' }, site: 'local', require_approval: false } }`

#### Scenario: Local plugin dispatches tool_call
- **WHEN** the SSE handler receives a `tool_call` event with `site: 'local'`
- **THEN** the handler invokes the session manager to execute the named tool via the registry, keyed by `call_id`

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

### Requirement: Local tool schema reporting at session creation
The local plugin SHALL report its local tool schemas and current workspace root to the cloud when creating a session. The session-creation request (`POST /api/agent/invoke/session`) SHALL accept optional `local_tools` (array of tool schemas) and `workspace_root` (the filesystem path of the current workspace root) fields. The cloud SHALL merge `local_tools` into the agent's tool set so the LLM is aware local tools exist, and SHALL associate `workspace_root` with the created session as contextual metadata. The cloud MUST NOT treat `workspace_root` as a cloud-accessible filesystem path. When either optional field is omitted, the cloud SHALL create the session without that context and SHALL NOT return an error.

#### Scenario: Tools and workspace root reported on session creation
- **WHEN** the plugin creates a session with `fs.read_file` registered locally and an open workspace rooted at `D:\\workspace`
- **THEN** it sends `local_tools` containing `fs.read_file` and `workspace_root` equal to `D:\\workspace`, and the cloud associates both with the created session

#### Scenario: Optional context omitted
- **WHEN** a session is created without `local_tools` or `workspace_root` fields
- **THEN** the cloud creates a normal chat-only session and does not error

### Requirement: Tool namespace isolation
Local tools SHALL use the namespaces `fs.` / `code.` / `terminal.` / `git.` to avoid collisions with cloud-side tools. The cloud SHALL preserve these names unchanged when surfacing tools to the LLM and when emitting `tool_call` events.

#### Scenario: Local tool name preserved end-to-end
- **WHEN** the plugin reports `fs.read_file` and the agent later calls it
- **THEN** the `tool_call` event's `tool` field is exactly `fs.read_file`

### Requirement: New SSE display events plan and progress
The SSE protocol SHALL additionally support `plan` (data: `{ steps: string[] }`) and `progress` (data: `{ message, current, total }`) event types for richer agent feedback. The local SSE handler SHALL parse and forward these to the UI; in Phase 1 the UI MAY render them minimally (the rendering fidelity is a Phase 5 concern). These events do not affect the tool-calling control flow.

#### Scenario: plan event parsed without error
- **WHEN** the cloud emits a `plan` event
- **THEN** the local SSE handler parses it and forwards it to the UI without treating it as content or an error

### Requirement: tool_result connect-time retry and cancel
The local tool-result submission SHALL retry only connect-time transient failures or failures explicitly classified as retryable, with exponential backoff and a maximum of three attempts. It SHALL NOT retry cancelled, validation, permission, path, or other non-retryable results. The local plugin SHALL support cancelling an in-flight continuation stream via `AbortController`.

#### Scenario: Non-retryable result is submitted once
- **WHEN** a local tool returns a path, permission, or user-cancelled result
- **THEN** the plugin submits it once and does not replay the tool execution

### Requirement: Duplicate tool-result acknowledgement handling
The local tool-result client SHALL inspect a successful response's Content-Type before consuming its body. A `text/event-stream` response SHALL be parsed as a continuation stream. An `application/json` response whose success payload contains `duplicate: true` SHALL be delivered through a distinct duplicate-acknowledgement outcome and SHALL NOT be passed to the SSE parser or reported through the normal SSE end callback. After a valid duplicate acknowledgement, the plugin MUST NOT resubmit the result or re-execute the tool.

#### Scenario: First result receives SSE continuation
- **WHEN** `/api/agent/invoke/tool_result` returns a successful `text/event-stream` response
- **THEN** the client parses its events and invokes the normal SSE end callback only after the continuation ends cleanly

#### Scenario: Duplicate result receives JSON acknowledgement
- **WHEN** `/api/agent/invoke/tool_result` returns `application/json` with a successful payload containing `duplicate: true`
- **THEN** the client reports the distinct duplicate acknowledgement without invoking the SSE parser, retrying the upload, re-executing the tool, or invoking the normal SSE end callback

#### Scenario: Unknown successful JSON response
- **WHEN** `/api/agent/invoke/tool_result` returns successful JSON that is not a valid duplicate acknowledgement
- **THEN** the client reports a protocol error instead of treating the response as a completed continuation

