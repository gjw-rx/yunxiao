## ADDED Requirements

### Requirement: Change-review records follow turn rollback and session deletion
The system SHALL remove persisted change-review records for a session when that session is deleted. A rollback of user-message sequence X SHALL remove the change-review records whose originating sequence is X or later in the same session.

#### Scenario: Cleanup after session deletion
- **WHEN** a session containing persisted change-review records is deleted
- **THEN** its change-review records are deleted together with its messages and rollback snapshots

#### Scenario: Cleanup after turn rollback
- **WHEN** a user rolls back a turn with sequence X
- **THEN** all change-review records from sequence X onwards are removed
