## ADDED Requirements

### Requirement: Per-turn managed-file change sets
The system SHALL create one change set for each Agent run that successfully changes files through `code_edit`, `fs_write_file`, `fs_delete_file`, or `fs_move_file`. The change set SHALL be isolated by workspace, session ID, and originating non-injected user-message sequence; it SHALL not include terminal commands, Git state, user edits, or another session's changes.

#### Scenario: Two replies modify different files
- **WHEN** two consecutive user turns in the same session respectively modify `a.ts` and `b.ts`
- **THEN** each final assistant reply references a distinct change set containing only its own file

#### Scenario: No managed-file mutation
- **WHEN** an Agent run only reads files or runs no successful managed write tool
- **THEN** the final assistant reply has no reviewable file entries

### Requirement: Immutable review snapshots and aggregate file result
For each affected path, the system SHALL retain the state before its first successful mutation in a change set and the state after its final successful mutation. The review result SHALL classify additions, modifications, and deletions and SHALL calculate summary additions and deletions from those stored states.

#### Scenario: Same file edited twice in one reply
- **WHEN** one Agent run successfully edits `a.ts` twice
- **THEN** its review shows one `a.ts` entry comparing the original content before the first edit with the final content after the second edit

#### Scenario: File deleted by managed tool
- **WHEN** a managed delete tool successfully removes `a.ts`
- **THEN** the review contains `a.ts` with its previous content and an empty final state

### Requirement: Dedicated change-review page
Every completed final assistant reply SHALL render a code-change action. The action SHALL show the affected-file count and aggregate line statistics when entries exist, and SHALL be disabled when none exist. Activating an enabled action SHALL open a dedicated WebviewPanel that lists the change set's files and allows selecting a file to view its stored before/after diff.

#### Scenario: Review a changed reply
- **WHEN** a final assistant reply is associated with a change set containing two files and the user activates its code-change action
- **THEN** a dedicated panel opens with both file rows and selecting either row displays its before/after content

#### Scenario: Reload historical session
- **WHEN** a user reopens a session containing a previously completed changed reply
- **THEN** that reply still exposes its own code-change action and opens the original stored review

### Requirement: Change-record lifecycle cleanup
The system SHALL delete all change records for a session when that session is deleted. When a user turn is rolled back, it SHALL remove the change records for that turn and every later turn in the same session.

#### Scenario: Roll back a changed turn
- **WHEN** a user rolls back the turn that created a change set
- **THEN** the change set is removed along with the reverted messages and cannot be opened afterwards

#### Scenario: Delete a session
- **WHEN** a user deletes a session with saved change sets
- **THEN** its change-record directory is removed while other sessions' records remain
