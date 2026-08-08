## MODIFIED Requirements

### Requirement: tool_call SSE event
The local `AgentLoop` SHALL parse tool calls from the LLM's streaming response (`choices[0].delta.tool_calls`) and emit `tool_state_change` events via `EventBus`. Tool calls SHALL originate from local LLM response parsing, not from cloud SSE events. The `ToolCall` object SHALL contain `call_id`, `tool`, and `args` fields. The `site` field SHALL be removed as all tools are local.

#### Scenario: LLM returns a tool call
- **WHEN** the LLM streaming response includes `tool_calls` in the delta
- **THEN** AgentLoop parses the tool call, emits a `tool_state_change` event with state `running`, and routes the call through `ToolRouter`

#### Scenario: Local plugin dispatches tool_call
- **WHEN** AgentLoop receives a parsed tool call for `fs.read_file`
- **THEN** it invokes `ToolRouter.route()` with the tool call, keyed by `call_id`

## REMOVED Requirements

### Requirement: tool_result HTTP endpoint contract
**Reason**: No cloud HTTP endpoint exists in local mode. Tool results are stored directly in `MessageStore` by `AgentLoop` as `tool` messages.
**Migration**: Tool results are now handled internally by `AgentLoop` appending to `MessageStore` and continuing the loop. No HTTP submission needed.

### Requirement: Stream-interrupt plus HTTP-resume continuation
**Reason**: There is no SSE stream to interrupt and no HTTP resume. The `AgentLoop` drives the full loop locally: LLM call -> tool execution -> append result -> next LLM call.
**Migration**: Continuation is handled by `AgentLoop`'s `while(true)` loop internally.

### Requirement: Local tool schema reporting at session creation
**Reason**: No cloud session creation API exists. Tool schemas are passed directly to the LLM request by `AgentLoop` via `toolSchemasToDefinitions()`.
**Migration**: `AgentLoop` builds `ToolDefinition[]` from `ToolRegistry.list()` and includes them in the `LLMRequest`.

### Requirement: Tool namespace isolation
**Reason**: Tool namespacing (`fs.`, `code.`, `terminal.`, `git.`) is still used for organization, but the "avoid collisions with cloud tools" rationale no longer applies.
**Migration**: Namespacing is retained as a convention but the cloud collision concern is removed.

### Requirement: New SSE display events plan and progress
**Reason**: `plan` and `progress` events are no longer received from a cloud SSE stream. The `AgentLoop` does not emit these events in its current implementation.
**Migration**: These event types remain in `EventBus` for future use but are not actively emitted by `AgentLoop`.

### Requirement: tool_result connect-time retry and cancel
**Reason**: No HTTP submission of tool results. Retry and cancel are handled by `AgentLoop` internally.
**Migration**: Tool execution timeout and cancellation are handled by `AgentLoop`'s `AbortController` and `ToolContext`.

### Requirement: Duplicate tool-result acknowledgement handling
**Reason**: No HTTP response to inspect for duplicate acknowledgements. Tool results are stored once in `MessageStore`.
**Migration**: Each tool result is appended exactly once to `MessageStore` by `AgentLoop`.
