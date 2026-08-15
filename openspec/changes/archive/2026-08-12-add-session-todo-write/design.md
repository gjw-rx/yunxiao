## Context

The extension already registers local tools, routes their executions through `AgentLoop`, persists sessions with `SessionFileStore`, and sends typed runtime events to the Webview through `EventBus` and `ChatPanel`. It has no durable task state. Its persisted message history is bounded, and context compaction deliberately omits older messages from the model-visible history.

Hermes Agent demonstrates a useful model: a full task-list tool response, explicit lifecycle states, bounded data, and reinjection of active work after compression. Hermes rebuilds an in-memory store from history and hides completed panels after a short delay. Those choices do not meet this extension's requirement to retain a session-visible completion record across restarts and history truncation.

## Goals / Non-Goals

**Goals:**

- Give the model one approval-free local tool to replace the current session task list.
- Keep one durable, session-scoped source of truth that survives extension restart, Webview reload, compression, and reopening a historical session.
- Keep active work visible to the model at every AgentLoop step and visible to the user in a dedicated panel.
- Preserve completed and cancelled tasks for the current session's task record while excluding them from model reinjection.
- Reuse existing tool routing, session persistence, EventBus, and Webview message patterns without new dependencies.

**Non-Goals:**

- User editing of model-managed tasks, task sharing, workspace-wide boards, due dates, priorities, nesting, or external synchronization.
- A generic planner protocol or reuse of the existing transient `plan` event as a task-state store.
- Persisting synthetic task-context messages in the chat transcript.

## Decisions

### 1. Expose a single full-replacement `todo_write` tool

The tool accepts a required `todos` array of `{ id, content, status }` objects and returns the normalized full snapshot plus status counts. List order is task priority. Valid states are `pending`, `in_progress`, `completed`, and `cancelled`; at most one item is `in_progress`.

The schema description directs the model to create a list for multi-step work, update it before and after meaningful work, complete tasks immediately, and replace the list when the plan changes. The tool uses `read` permission because it does not alter workspace resources or invoke an external side effect, so progress updates do not interrupt the model with approvals. It remains non-parallel to avoid same-step competing replacements.

`merge`, a separate read tool, timestamps, priority fields, and nested items are rejected for the initial change. A full snapshot is idempotent and directly represents what the UI must render; partial merge semantics create unnecessary state ambiguity.

### 2. Store task snapshots alongside session metadata

`SessionFileStore` extends its workspace-local `index.json` with a session-id keyed task snapshot. A `SessionTodoStore` wraps this storage, validates and normalizes writes, and is the sole producer of task snapshots. Deleting a session removes both its JSONL transcript and its task snapshot through the same serialized, atomic index update path.

Using the session index instead of reconstructing from the last `todo_write` tool result avoids losing task state when the message-store limit removes old messages. It also avoids a second sidecar file and makes session cleanup atomic. A missing or malformed legacy task entry is treated as an empty task list so existing indexes need no migration.

### 3. Reinject only active tasks as transient system context

Before every model request, `AgentLoop` reads the current session snapshot and adds a compact system message containing only `pending` and `in_progress` items. The message is built anew for every loop step, never appended to `MessageStore`, and participates in request-token estimation and compaction triggering.

This keeps task state current immediately after the tool runs, survives a compaction boundary without altering tool-call pairing, and prevents completed work from being repeated. It is preferable to adding a synthetic user message, because this codebase already supports system messages in normal and compaction histories and the snapshot is extension-owned execution context rather than user intent.

### 4. Publish a dedicated task-state event and render current state outside the transcript

`TodoWriteTool` writes the store and emits a typed `todo_state_change` event containing the snapshot. `ChatPanel` forwards it as a `todoState` host-to-Webview message. When history is loaded or the active session changes, `ChatPanel` also sends that session's stored snapshot so a restart or historical-session switch renders deterministically.

The Webview reducer stores one task snapshot for the active session. A read-only, collapsible `TodoPanel` renders it between the message list and input. It shows a completed/total summary and status-specific rows. It remains visible after the final completion until the model writes an empty/replacement list or the user changes/deletes the session.

Reusing a `MessageItem` or the existing `plan` event is rejected: both represent timeline entries, whereas this panel represents the latest durable state and must not create a new transcript item on every progress update.

## Risks / Trade-offs

- [The model omits a progress update] → The panel accurately preserves the last confirmed snapshot; tool guidance and integration tests encourage updates around meaningful steps.
- [Oversized model input enlarges the task snapshot] → Enforce bounded item count and content length during validation, and return a structured validation error without changing stored state.
- [A legacy or malformed index contains task data] → Read it defensively as empty and retain normal session behavior; the next valid write replaces it.
- [Task context contributes to context pressure] → Inject only active tasks, cap its size, and include it in the existing request estimator before compaction decisions.
- [Current context-compaction work changes AgentLoop] → Keep the integration at request assembly only; rebase the implementation on the completed compaction change and preserve its tool-pair sanitation behavior.

## Migration Plan

1. Add optional task-snapshot data to the existing session-index parser with an empty default.
2. Release without a migration script; existing sessions receive empty task state until the model first calls `todo_write`.
3. On session deletion, remove task state with the existing session cleanup path.
4. Roll back by removing task consumers; the optional index field is harmless to older releases and existing JSONL transcripts remain unchanged.

## Open Questions

None. The initial panel is read-only and retains its completed snapshot by design; manual task editing can be evaluated as a separate change.
