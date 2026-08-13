## Context

`code_edit` currently creates temporary before/after files and opens `vscode.diff` before its approval request. The existing inline DiffCard represents one tool call and is neither durable nor suitable for a multi-file review page. Session data and rollback snapshots are already isolated by session and user-message sequence.

## Goals / Non-Goals

**Goals:**

- Preserve secure approval and concurrent-write protection while removing automatic editor interruption.
- Persist an immutable, per-turn change set for successful plugin-managed writes.
- Display that change set from the final assistant response in a dedicated WebviewPanel.
- Keep review records correct across Webview reload, rollback, and session deletion.

**Non-Goals:**

- Attribute arbitrary `terminal_exec` or user-originated workspace edits to an Agent turn.
- Use Git status/diff as a fallback data source.
- Change existing Git diff tooling or add cloud persistence.

## Decisions

### A change set is scoped by session and originating user-message sequence

One `AgentLoop.run` begins with one non-injected user message; all successful managed file writes in that run belong to its change set. The final assistant message stores the resulting `changeSetId`, making historical replies reopen their own review independently. This matches a visible “code changes” action after each reply and prevents cross-turn leakage.

### Record first-before and latest-after snapshots in a dedicated change journal

Write tools call a `ChangeRecorder` around their resolved file mutations. The journal captures the first pre-mutation snapshot for a path and refreshes its final state after each successful mutation. At run completion it writes a manifest with file status and line statistics. Dedicated snapshots are required because rollback records do not contain durable after states, and Git/current-workspace diffs can include unrelated edits.

### Cover only resolved plugin-managed write tools in the first release

`code_edit`, `fs_write_file`, `fs_delete_file`, and `fs_move_file` have guarded target paths and deterministic outcomes. `terminal_exec` can mutate unbounded paths and cannot be correctly attributed without a broad watcher, so it is intentionally excluded.

### Use a separate review WebviewPanel with lazy file detail loading

The chat reply action requests a singleton review panel. The panel first receives a compact summary/file list; selecting a file requests its snapshot data and renders a side-by-side textual diff. This preserves the existing dark Webview visual language and avoids injecting large diff payloads into the chat protocol.

### Keep approval but remove `DiffViewer` invocation

`code_edit` continues to compute its unified diff for approval summary and returns result metadata, but no longer writes preview temp files or executes `vscode.diff`. Successful application is what enters the change journal.

## Risks / Trade-offs

- [Snapshot growth] → Store only managed-file snapshots per turn; remove records on rollback/session deletion and cap review payloads sent to Webview.
- [External edits after a run] → Review saved snapshots rather than live files, so the displayed result remains attributable.
- [Multi-write paths] → Preserve only the first before state and latest after state for each path.
- [Move operations] → Initially record source removal and destination creation as two file records; rename detection is not required for correctness.

## Migration Plan

1. Add the journal and recorder dependency beside the existing rollback journal.
2. Instrument managed write tools and bind completed change sets to final assistant messages.
3. Add host/Webview protocol and the review panel.
4. Remove obsolete automatic preview behavior and inline DiffCard emission.
5. Verify lifecycle cleanup and compile/tests. Reverting the change removes the new journal without touching workspace files.

## Open Questions

None for the first release; terminal-originated changes remain explicitly out of scope.
