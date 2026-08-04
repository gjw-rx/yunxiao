## Why

The cloud Run event log now provides a stable `run_id` and ordered `sequence`, but the VS Code extension retains neither after reload or a transport loss. The extension therefore cannot distinguish a duplicate event from a missing event, or safely resume an interrupted workspace session.

## What Changes

- Add a VS Code workspace-state-backed RunStore for per-session Run snapshots, ordered event cursors, and retained timeline events.
- Add ordered event ingestion that de-duplicates replayed events, detects sequence gaps, and requests replay from the last contiguous cursor.
- Restore a saved non-terminal Run when the extension activates, then reconnect its subscription without inferring a cloud terminal result.
- Retain existing v1 stream behavior as a compatibility path while introducing the v2 Run command and subscription client surface.

## Capabilities

### New Capabilities

- `plugin-run-store-replay`: Local persistence, ordered consumption, gap recovery, and workspace restoration for cloud Run events.

### Modified Capabilities

- `session-orchestration`: Session orchestration consumes cloud Run events through the persistent local cursor and restores a saved active Run.

## Impact

- Affects `src/aiClient.ts`, `src/core/sessionManager.ts`, shared protocol types, extension activation, and focused unit tests.
- Uses VS Code `ExtensionContext.workspaceState`; introduces no database or new runtime dependency.
