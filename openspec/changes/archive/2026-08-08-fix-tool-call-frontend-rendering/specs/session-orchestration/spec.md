## MODIFIED Requirements

### Requirement: Tool call lifecycle
The session manager SHALL track each tool call through `pending` -> `running` -> `success` | `error` states. The current state SHALL be queryable so the UI can render tool-call status. A tool call that errors SHALL still produce a `tool_result` with `status: 'error'` so the cloud can adjust its strategy.

#### Scenario: Successful tool call transitions to success
- **WHEN** `fs.read_file` executes and returns content
- **THEN** the call's state becomes `success` and a success `tool_result` is posted

#### Scenario: Failed tool call posts error result
- **WHEN** `fs.read_file` fails (e.g. file not found)
- **THEN** the call's state becomes `error` and a `tool_result` with `status: 'error'` and the reason is posted, so the agent can recover

#### Scenario: Pending state visible to UI before execution
- **WHEN** the LLM returns a tool call and the AgentLoop emits a `tool_call` event
- **THEN** the UI can render a `pending` tool step before the tool begins executing

## ADDED Requirements

### Requirement: History entry preserves tool call metadata
The `HistoryEntry` interface SHALL include optional `toolCalls` for assistant messages and `toolCallId` for tool role messages, so that loading history restores the full tool call timeline.

#### Scenario: Assistant message with tool calls in history
- **WHEN** history is loaded for a session that had tool calls
- **THEN** assistant messages include their `toolCalls` array and tool messages include their `toolCallId`

#### Scenario: Tool messages retained in history
- **WHEN** history is loaded for a session
- **THEN** `tool` role messages are included in the returned history entries, not filtered out
