## ADDED Requirements

### Requirement: Persistent Run event records
The system SHALL persist each Run event with a logical `run_id`, a Run-local `sequence`, an `event_type`, a JSON `payload`, and standard timestamps. The system SHALL enforce uniqueness for `(run_id, sequence)` without a database foreign key or cascade to AgentRun.

#### Scenario: Event metadata remains lightweight
- **WHEN** the AgentRunEvent metadata is inspected
- **THEN** it contains event ordering and payload fields but no graph step, pending task, interrupt, checkpoint state, lease, or tool execution receipt fields

#### Scenario: Duplicate sequence is rejected
- **WHEN** two event rows use the same `run_id` and `sequence`
- **THEN** the database rejects the second row

### Requirement: Run-local sequence allocation
The system SHALL allocate event sequences independently per Run, beginning at 1 and increasing by one for every committed event.

#### Scenario: First event begins at one
- **WHEN** an event is appended to a Run with no prior committed events
- **THEN** the event sequence is 1 and the Run next-sequence cursor becomes 2

#### Scenario: Different Runs have independent sequences
- **WHEN** the first event is appended to each of two Runs
- **THEN** both events receive sequence 1

#### Scenario: Concurrent appends are serialized
- **WHEN** multiple transactions concurrently append events to the same Run
- **THEN** the Run row is locked and the committed events receive unique contiguous sequences

### Requirement: Atomic event append transaction
The system SHALL lock the target Run, allocate its current cursor, insert the event, and advance the cursor in one database transaction. It MUST NOT derive the next sequence with `max(sequence) + 1`.

#### Scenario: Successful append commits event and cursor
- **WHEN** an event append transaction succeeds
- **THEN** the event row and advanced Run cursor become visible together

#### Scenario: Failed append consumes no sequence
- **WHEN** event insertion or transaction commit fails
- **THEN** neither the event nor the cursor advancement is committed

#### Scenario: Missing Run cannot receive an event
- **WHEN** an append targets a `run_id` that does not exist
- **THEN** the transaction fails without inserting an event

### Requirement: Ordered cursor reads
The system SHALL read events for one Run after an exclusive sequence cursor in ascending sequence order with a positive caller-supplied limit.

#### Scenario: Read events after a cursor
- **WHEN** events 1 through 5 exist and the caller reads after sequence 2
- **THEN** the result begins with sequence 3 and is ordered ascending

#### Scenario: Run events remain isolated
- **WHEN** different Runs contain events with overlapping sequence values
- **THEN** a cursor read returns only events belonging to the requested Run

#### Scenario: Invalid read limit is rejected
- **WHEN** the caller supplies a non-positive limit
- **THEN** the service rejects the request before querying events
