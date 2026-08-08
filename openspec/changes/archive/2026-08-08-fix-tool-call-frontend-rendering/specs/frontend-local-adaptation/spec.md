## ADDED Requirements

### Requirement: Tool call pending state in webview
The webview SHALL handle `toolCall` postMessage commands by creating a tool step with `pending` state in the trace timeline, showing the tool name, arguments preview, and a pending status icon, before the tool starts executing.

#### Scenario: Tool call received before execution
- **WHEN** the webview receives `{ command: 'toolCall', call_id, tool, args }`
- **THEN** a tool step element is created in the trace with `pending` state, displaying the tool icon, tool name, and argument summary

#### Scenario: Pending state transitions to running
- **WHEN** a tool step already exists with `pending` state and the webview receives `{ command: 'toolState', state: 'running' }` for the same `call_id`
- **THEN** the existing tool step is updated to `running` state without creating a duplicate element

### Requirement: Diff card rendering for code.edit
The ChatViewProvider SHALL detect `code.edit` tool success results that contain diff metadata and forward them to the webview as `diffResult` commands, activating the existing `showDiffCard` rendering.

#### Scenario: code.edit success with diff
- **WHEN** a `tool_state_change` event arrives with `tool === 'code.edit'`, `state === 'success'`, and the output contains diff data
- **THEN** the ChatViewProvider posts `{ command: 'diffResult', call_id, file_path, diff_html, additions, deletions }` to the webview

#### Scenario: Non-edit tool success does not trigger diff card
- **WHEN** a `tool_state_change` event arrives for a tool other than `code.edit`
- **THEN** no `diffResult` command is posted

### Requirement: History restoration of tool call steps
The webview SHALL render tool call steps from history when a session is loaded, restoring the trace timeline with tool name, arguments, and results.

#### Scenario: Loading history with tool calls
- **WHEN** the webview receives `historyLoaded` messages containing `assistant` messages with `toolCalls` and `tool` role messages
- **THEN** each tool call is rendered as a tool step in the trace timeline, showing tool name, arguments, and result content

#### Scenario: Loading history without tool calls
- **WHEN** the webview receives `historyLoaded` messages containing only `user` and `assistant` messages without `toolCalls`
- **THEN** no tool steps are rendered in the trace timeline
