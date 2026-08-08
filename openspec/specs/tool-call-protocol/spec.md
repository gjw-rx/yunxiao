# tool-call-protocol Specification

## Purpose
TBD - created by archiving change phase1-local-tool-calling. Update Purpose after archive.
## Requirements
### Requirement: tool_call SSE event
The local `AgentLoop` SHALL parse tool calls from the LLM's streaming response (`choices[0].delta.tool_calls`) and emit `tool_state_change` events via `EventBus`. Tool calls SHALL originate from local LLM response parsing, not from cloud SSE events. The `ToolCall` object SHALL contain `call_id`, `tool`, and `args` fields. The `site` field SHALL be removed as all tools are local.

#### Scenario: LLM returns a tool call
- **WHEN** the LLM streaming response includes `tool_calls` in the delta
- **THEN** AgentLoop parses the tool call, emits a `tool_state_change` event with state `running`, and routes the call through `ToolRouter`

#### Scenario: Local plugin dispatches tool_call
- **WHEN** AgentLoop receives a parsed tool call for `fs.read_file`
- **THEN** it invokes `ToolRouter.route()` with the tool call, keyed by `call_id`

### Requirement: Tool call event emission
The AgentLoop SHALL emit a `tool_call` event on the EventBus immediately when the LLM stream parser yields a `toolCall` LLMEvent, before the tool is executed. The event payload SHALL contain `call_id`, `tool` (tool name), and `args` (parsed arguments object).

#### Scenario: Model decides to call a tool
- **WHEN** the stream parser yields a `toolCall` event with id, name, and arguments
- **THEN** the AgentLoop emits a `tool_call` EventBus event with payload `{ call_id, tool, args }` before any tool execution begins

#### Scenario: Multiple tool calls in one LLM response
- **WHEN** the stream parser yields two or more `toolCall` events
- **THEN** the AgentLoop emits a `tool_call` event for each one, in order, before executing any of them

### Requirement: Tool result event forwarding
The ChatViewProvider SHALL forward `tool_result` EventBus events to the webview as `toolResult` postMessage commands, containing the full `ToolResult` payload.

#### Scenario: Tool result is forwarded to webview
- **WHEN** the AgentLoop emits a `tool_result` event
- **THEN** the ChatViewProvider posts `{ command: 'toolResult', ...resultPayload }` to the webview