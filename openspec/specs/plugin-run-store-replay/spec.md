# plugin-run-store-replay Specification

## Purpose

Provide the VS Code plugin with a durable local cursor and safe replay path for cloud Run events across reloads and transport interruptions.

## Requirements

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

### Requirement: Contiguous event consumption
The plugin SHALL advance a stored Run cursor only for an event whose sequence is exactly one greater than the stored cursor. It MUST ignore a replayed event whose sequence is at or below the cursor and MUST report a sequence gap without advancing the cursor.

#### Scenario: Replay is de-duplicated
- **WHEN** a Run cursor is 4 and sequence 4 is received again
- **THEN** the plugin does not append the event or advance the cursor

#### Scenario: Gap does not skip cursor
- **WHEN** a Run cursor is 4 and sequence 6 is received before sequence 5
- **THEN** the plugin reports a gap from sequence 5 and retains cursor 4

### Requirement: Replay and restored subscription
The plugin SHALL subscribe to a cloud Run using the stored exclusive cursor and SHALL retry from that cursor after a gap or a transport loss. On activation it SHALL restore and subscribe only non-terminal snapshots. A restored local tool call MUST be presented as pending and MUST NOT be automatically executed.

#### Scenario: Gap triggers exclusive-cursor replay
- **WHEN** sequence 8 is received while the stored cursor is 6
- **THEN** the plugin reconnects with `after_sequence=6`

#### Scenario: Interrupted Run restores safely
- **WHEN** activation finds an interrupted Run snapshot with a retained local tool call
- **THEN** the plugin resumes subscription from its stored cursor and does not execute the tool call automatically
