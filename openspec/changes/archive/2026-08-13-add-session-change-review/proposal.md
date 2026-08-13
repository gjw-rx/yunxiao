## Why

`code_edit` currently opens the VS Code diff editor before every approved edit, interrupting the conversation flow. The chat also lacks a durable, session-isolated way to review the files changed by one completed Agent reply.

## What Changes

- Stop automatically opening the VS Code diff editor for `code_edit` previews while preserving approval and concurrent-write protection.
- Record successful plugin-managed file changes as one immutable change set per user turn in a session.
- Show a code-change action at the end of every final assistant reply and open a dedicated change-review page when that turn changed files.
- Provide a file summary and before/after diff view from stored snapshots, including newly created and deleted files.
- Keep change records consistent with session deletion and turn rollback.

## Capabilities

### New Capabilities

- `session-change-review`: Persist and review the plugin-managed file changes produced by one completed conversation turn.

### Modified Capabilities

- `code-edit`: Replace automatic VS Code diff-editor preview with non-disruptive approval and post-apply change-set capture.
- `conversation-delete-rollback`: Remove change-review records when their session or source turn is removed by lifecycle operations.

## Impact

- Affects write tools, AgentLoop completion, session lifecycle storage, host/Webview protocol, ChatPanel, and React Webview UI.
- Adds local snapshot storage beneath the workspace-isolated session data directory; no cloud or Git dependency is introduced.
