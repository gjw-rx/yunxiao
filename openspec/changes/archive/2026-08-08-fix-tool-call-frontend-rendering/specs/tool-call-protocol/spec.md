## ADDED Requirements

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
