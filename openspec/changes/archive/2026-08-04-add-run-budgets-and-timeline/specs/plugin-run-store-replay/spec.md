## MODIFIED Requirements

### Requirement: Workspace-scoped Run snapshots
The plugin SHALL persist a bounded Run snapshot for each session in VS Code workspace state. Each snapshot MUST contain the cloud `run_id`, its session ID, the last contiguous sequence cursor, lifecycle state, workspace roots, retained protocol events, a bounded timeline projection, and the latest authoritative budget payload when one has been accepted. An explicit session reset MUST remove that session's snapshot.

#### Scenario: Snapshot survives extension-host recreation
- **WHEN** a non-terminal Run has consumed events through sequence 5 and the extension host is recreated
- **THEN** the plugin reads the same Run ID and cursor 5 with its retained timeline and budget snapshot

#### Scenario: Explicit reset clears snapshot
- **WHEN** the user resets a session with a stored Run snapshot
- **THEN** a subsequent read for that session returns no stored Run

#### Scenario: Legacy snapshot remains readable
- **WHEN** a workspace contains a snapshot written before timeline or budget fields existed
- **THEN** the plugin loads it with an empty timeline and no budget snapshot
