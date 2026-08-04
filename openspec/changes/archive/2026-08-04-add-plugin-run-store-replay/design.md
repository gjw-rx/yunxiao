## Context

The cloud service now owns Run computation and persists monotonic Run-local events. The extension still drives v1 request-bound streams and keeps state only in `SessionManager`, so a window reload loses the Run ID, consumed cursor, and timeline needed to reconnect safely. VS Code supplies `ExtensionContext.workspaceState`, which is scoped to a workspace and survives extension-host reloads.

## Goals / Non-Goals

**Goals:**

- Persist the active Run identity, latest contiguous sequence, lifecycle state, workspace roots, and a bounded event timeline per session.
- Accept an event only once, identify an out-of-order gap without advancing the cursor, and replay from the last contiguous cursor.
- Rehydrate an unfinished Run on activation so its event subscription can resume from its stored cursor.
- Keep the existing v1 API usable while adding an isolated v2 Run client surface.

**Non-Goals:**

- Persist tool execution receipts or automatically replay a non-idempotent local tool.
- Make the extension a second source of truth for Run status or event history.
- Add cross-window synchronization, an execution lease, budget enforcement, or Webview timeline redesign.

## Decisions

### Store a bounded session-keyed snapshot in workspace state

`RunStore` serializes a small `StoredRun` record beneath one namespaced workspace-state key. A record holds the cloud `runId`, last contiguous sequence, lifecycle state, workspace roots, and a bounded sequence-indexed event array. A single key makes writes atomic at the VS Code memento boundary and enables removal on explicit session reset. A file-backed store was rejected because it would add workspace files and recovery/migration concerns for purely UI-owned state.

### Treat contiguous sequence as the only cursor

`RunStore.append` accepts a new event only when its sequence is exactly `cursor + 1`; an already-consumed event is ignored and a higher sequence is reported as a gap. The cursor never follows timestamps or the highest buffered event. This mirrors the cloud's exclusive `after_sequence` contract and avoids silently losing events during reconnect.

### Separate v2 transport from existing SSE callbacks

`AIClient` adds explicit create, post-result, and subscribe operations for cloud Runs. Subscription yields complete protocol events containing `run_id` and `sequence`; the session manager owns persistence and recovery. The existing `streamMessage` and `submitToolResult` calls remain intact until callers migrate, avoiding a breaking change to the legacy service.

### Restore only non-terminal snapshots

Activation loads snapshots and hands each running or interrupted Run to `SessionManager.restoreRun`. Terminal snapshots remain available for UI history but are never re-subscribed. A restored `tool_call` is surfaced as pending rather than executed automatically; execution receipts belong to the following journal change.

## Risks / Trade-offs

- [WorkspaceState quota grows with event payloads] → retain only a small configurable fixed event count and discard oldest events after the cursor is advanced.
- [A crash occurs between cloud delivery and local persistence] → reconnect from the persisted exclusive cursor; duplicate events are ignored.
- [A missing cloud v2 endpoint is deployed] → use v1 unchanged; v2 calls surface their server error and do not mutate a snapshot optimistically.
- [A restored local tool could be unsafe to run twice] → do not auto-execute restored tool calls.

## Migration Plan

1. Ship the store and v2 client/session orchestration behind the existing extension API without changing v1 routes.
2. On activation, absence or malformed stored state behaves as an empty store.
3. If recovery causes a regression, disable v2 callers and retain the stored snapshots; v1 streams continue to work.
