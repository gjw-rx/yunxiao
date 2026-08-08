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