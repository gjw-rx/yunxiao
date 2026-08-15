## MODIFIED Requirements

### Requirement: tool_call SSE event
The local `AgentLoop` SHALL receive normalized tool calls from the AI SDK model runtime's `fullStream` rather than directly parsing `choices[0].delta.tool_calls`. Tool calls SHALL originate from the local AI SDK stream adapter, not from cloud SSE events. The `ToolCall` object SHALL contain `call_id`, `tool`, and `args` fields. The `site` field SHALL be removed as all tools are local.

#### Scenario: AI SDK returns a tool call
- **WHEN** the AI SDK `fullStream` includes a complete `tool-call` part
- **THEN** the model runtime emits a normalized tool call, AgentLoop emits a `tool_state_change` event with state `running`, and routes the call through `ToolRouter`

#### Scenario: Local plugin dispatches tool_call
- **WHEN** AgentLoop receives a normalized tool call for `fs_read_file`
- **THEN** it invokes `ToolRouter.route()` with the tool call, keyed by `call_id`

### Requirement: Tool call event emission
The AgentLoop SHALL emit a `tool_call` event on the EventBus immediately when the AI SDK stream adapter yields a complete `toolCall` LLMEvent, before the tool is executed. The event payload SHALL contain `call_id`, `tool` (tool name), and `args` (parsed arguments object).

#### Scenario: Model decides to call a tool
- **WHEN** the AI SDK stream adapter yields a `toolCall` event with id, name, and arguments
- **THEN** the AgentLoop emits a `tool_call` EventBus event with payload `{ call_id, tool, args }` before any tool execution begins

#### Scenario: Multiple tool calls in one LLM response
- **WHEN** the AI SDK stream adapter yields two or more complete `toolCall` events
- **THEN** the AgentLoop emits a `tool_call` event for each one, in stream order, before executing any of them
