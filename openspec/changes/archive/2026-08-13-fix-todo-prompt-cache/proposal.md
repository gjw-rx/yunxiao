## Why

`todo_write` currently causes every subsequent model request to prepend a mutable active-task system message ahead of the complete conversation history. Completing or advancing a task changes that early message, so provider prompt caches cannot reuse the otherwise unchanged history prefix and may rewrite the cache for each progress update.

## What Changes

- Preserve the current durable, session-scoped todo snapshot and Webview progress panel.
- Stop prepending the active todo snapshot to every AgentLoop request.
- Continue exposing the latest active todo state when it is no longer represented in model-visible history, including after context compaction and when resuming a session whose relevant todo tool result is unavailable.
- Persist the active todo context with a compaction checkpoint so that post-compaction requests receive a stable task context rather than a newly rebuilt per-request prefix.
- Add request-assembly tests that distinguish a normal todo tool follow-up from a recovery path and verify the stable request prefix is retained across todo state transitions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `session-todo-tracking`: Change active-task context injection from unconditional per-request system context to recovery-only context that preserves prompt-cache-friendly request ordering while retaining task continuity.
- `context-compaction`: Preserve the active todo context as deterministic checkpoint data for post-compaction history reconstruction.

## Impact

- Affected runtime: `src/agent/agentLoop.ts`, `src/agent/compaction.ts`, todo-context formatting, and effective-history reconstruction.
- Affected tests: AgentLoop todo-context and compaction-boundary coverage.
- No change to the `todo_write` schema, persisted session index, Webview protocol, external API, or dependencies.
