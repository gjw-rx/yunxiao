# tool-call-protocol Specification

## Purpose
TBD - created by archiving change phase1-local-tool-calling. Update Purpose after archive.
## Requirements
### Requirement: tool_call SSE event
The local AgentLoop SHALL receive normalized tool calls from the AI SDK model runtime fullStream. Calls for static tools and dynamic MCP tools SHALL use the same Core ToolCall containing call_id, model-visible tool and args. Tool source, Server ID, native MCP tool, Transport and permission SHALL be resolved from trusted registry/catalog metadata and MUST NOT be accepted from the model event.

#### Scenario: AI SDK returns local call
- **WHEN** fullStream contains a complete `fs_read_file` tool-call
- **THEN** AgentLoop emits running state and routes it through ToolRouter

#### Scenario: AI SDK returns MCP call
- **WHEN** fullStream contains `mcp__codegraph__codegraph_explore`
- **THEN** AgentLoop routes the same normalized shape through ToolRouter to the adapter

#### Scenario: Model supplies fake endpoint
- **WHEN** model args include fake URL, command or Server ID
- **THEN** invocation still uses the stored trusted catalog entry

### Requirement: Tool call event emission
The AgentLoop SHALL emit a tool_call EventBus event immediately when a complete toolCall LLMEvent arrives, before execution. The payload SHALL contain call_id, model-visible tool and parsed args for static and MCP calls.

#### Scenario: MCP call event
- **WHEN** stream adapter yields an MCP tool call
- **THEN** EventBus receives its call ID, exposed name and args before validation or protocol invocation

#### Scenario: Mixed calls preserve stream order
- **WHEN** one response contains multiple local and MCP calls
- **THEN** AgentLoop emits one event per call in stream order before applying execution policy

### Requirement: Tool result event forwarding
ChatViewProvider SHALL forward tool_result EventBus events to the Webview for static and MCP tools, containing the governed ToolResult and original model call ID.

#### Scenario: Remote MCP result forwarded
- **WHEN** a remote MCP adapter completes
- **THEN** Webview receives the governed result associated with the same call ID

### Requirement: MCP result continuation
AgentLoop SHALL persist the assistant MCP Function Call and matching governed tool result through the existing history contract, then include both in the next model request. MCP success, error, cancellation and unavailable results SHALL all continue the loop with exactly one matching tool message.

#### Scenario: MCP success continues generation
- **WHEN** tools/call succeeds for call ID `call-1`
- **THEN** the next model request contains the matching tool result and generation can continue

#### Scenario: MCP failure continues generation
- **WHEN** Transport returns a structured error
- **THEN** the next model request contains that matching failure and AgentLoop can re-plan
