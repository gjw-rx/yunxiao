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
The cloud SHALL expose `POST /api/agent/invoke/tool_result` accepting a body with `session_id`, `call_id`, `status` (`'success' | 'error' | 'cancelled'`), `result` (string, the tool output or JSON-stringified output), optional `error` (failure reason), and optional `metadata` (`affected_files`, `diff`, `duration_ms`). The response SHALL be an SSE stream: the cloud injects the tool result into the conversation state, re-invokes the agent (continuation), and streams subsequent events (content / thought / further `tool_call` / end) as the HTTP response body. A non-streaming 4xx error response SHALL use the standard API envelope (`{ success, error }`). The local plugin SHALL call this endpoint exactly once per `tool_call` it received; the returned stream IS the continuation (no separate continuation endpoint).

#### Scenario: Successful result posted
- **WHEN** the local plugin finishes `fs.read_file` with content
- **THEN** it POSTs `{ session_id, call_id, status: 'success', result: '<content>', metadata: { duration_ms } }` and reads the SSE continuation stream returned by the cloud

#### Scenario: Cancelled result posted
- **WHEN** the user denies or stops a tool call
- **THEN** the local plugin POSTs `{ session_id, call_id, status: 'cancelled', error: 'user denied' }` and the cloud adjusts its strategy (streamed in the response) rather than retrying the same call

### Requirement: Stream-interrupt plus HTTP-resume continuation
When the cloud emits a `tool_call` for a local tool, the SSE stream SHALL end (after yielding the `tool_call` event). The local plugin SHALL execute the tool and POST the result to `/tool_result`; the cloud SHALL re-invoke the agent (continuation) with the tool result injected into the conversation state, returning a NEW SSE stream as the `/tool_result` response body for the same session. The local plugin SHALL treat both "user sends message" and "tool result posted" as triggers for a new SSE stream. No WebSocket is required.

#### Scenario: One continuation round
- **WHEN** the agent issues one `tool_call`, the message stream ends, the result is posted, and the cloud resumes
- **THEN** the `/tool_result` response is a new SSE stream that delivers the final content and ends; the local plugin renders the continuation under the same session

#### Scenario: Continuation history includes tool messages
- **WHEN** the cloud resumes after a tool_result
- **THEN** the conversation state passed to the agent includes the prior assistant tool_call message and the matching tool result message, so the agent reasons over the tool output

### Requirement: Local tool schema reporting at session creation
The local plugin SHALL report its local tool schemas to the cloud when creating a session. The session-creation request (`POST /api/agent/invoke/session`) SHALL accept an optional `local_tools` field (array of tool schemas). The cloud SHALL merge these into the agent's tool set so the LLM is aware local tools exist. When `local_tools` is omitted, the cloud SHALL behave as before (no local tools, pure chat).

#### Scenario: Tools reported on session creation
- **WHEN** the plugin creates a session and has `fs.read_file` registered locally
- **THEN** the request body includes `local_tools: [<fs.read_file schema>]` and the cloud makes the tool available to the agent

#### Scenario: Backward compatibility without local_tools
- **WHEN** a session is created without the `local_tools` field (e.g. older client)
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
The local tool-result submission SHALL retry connect-time transient failures (network errors and 5xx responses, before any streaming begins) with exponential backoff (maximum 3 attempts). Non-transient failures (4xx) SHALL not be retried and SHALL surface a friendly error via `onError`. Once the SSE continuation stream has begun, no retry SHALL occur. The local plugin SHALL support cancelling an in-flight `/tool_result` stream via `AbortController` (user stop).

#### Scenario: Transient connect error retried
- **WHEN** the `/tool_result` POST fails with a connection error before streaming begins
- **THEN** the client retries up to 3 times with backoff before surfacing an error

#### Scenario: 4xx not retried
- **WHEN** the `/tool_result` POST returns a 400 with `{ success: false, error }`
- **THEN** the client does not retry and surfaces the error message via `onError`

#### Scenario: User cancels mid-stream
- **WHEN** the user stops while the continuation stream is being read
- **THEN** the AbortController aborts the stream, no `onEnd` is emitted, and no further events are processed

