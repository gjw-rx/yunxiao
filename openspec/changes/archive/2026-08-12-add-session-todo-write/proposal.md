## Why

The agent currently has no durable, structured way to publish and update its execution plan. Users therefore cannot see which work is pending, in progress, or completed, and the model can lose track of unfinished work after context compression.

## What Changes

- Add a local `todo_write` tool that lets the model replace the current session's ordered task list with explicit task states.
- Persist the latest task snapshot with its session so it survives Webview reloads, extension restarts, context compaction, and history-session reopening.
- Inject only active tasks into each model request so the agent retains its working plan without redoing completed work.
- Add a read-only, collapsible task-progress panel to the chat Webview that shows the current session's completion state.
- Publish typed task-state updates through the existing EventBus and Webview protocol instead of treating task updates as ordinary chat messages.

## Capabilities

### New Capabilities

- `session-todo-tracking`: Model-managed, session-scoped task tracking, active-task context injection, and task-progress display.

### Modified Capabilities

- `session-history-storage`: Persist task snapshots in the workspace session index and remove them together with their sessions.

## Impact

- Affected extension services: `SessionFileStore`, a new session Todo store, `TodoWriteTool`, tool registration, `AgentLoop`, and `EventBus`.
- Affected UI boundary: `ChatPanel`, Webview protocol, reducer state, and a new task-progress component.
- No external service, model-provider API, workspace file, or new package dependency is required.
