## ADDED Requirements

### Requirement: Durable client request admission
The system SHALL persist the `(session_id, client_request_id)` admission identity before scheduling initial compute. A repeated request with that identity SHALL return the original run and SHALL NOT create a second initial-compute task.

#### Scenario: Retried client request
- **WHEN** a client submits the same session and client request ID after the original admission succeeded
- **THEN** the system returns the existing run ID and does not invoke initial computation again

### Requirement: Durable tool-result receipt hash
The system SHALL persist a SHA-256 hash for every accepted `(run_id, tool_call_id)` tool result. A retry with the same hash SHALL receive an idempotent acknowledgement; a retry with a different hash SHALL be rejected and SHALL NOT resume the run.

#### Scenario: Identical tool-result retry
- **WHEN** a client resubmits an accepted tool result with identical normalized content
- **THEN** the system acknowledges the existing receipt without reinjecting the result

#### Scenario: Conflicting tool-result retry
- **WHEN** a client resubmits the same tool call ID with different normalized content
- **THEN** the system rejects the request and leaves the existing receipt and run state unchanged

### Requirement: Leased run continuation
The system SHALL require an unexpired run lease before scheduling initial computation, tool-result continuation, or recovery. A lease claim SHALL be atomic and only its owner SHALL update continuation state; an expired lease MAY be claimed by another instance.

#### Scenario: Competing continuation claim
- **WHEN** two instances try to continue the same run while one holds an unexpired lease
- **THEN** exactly one instance schedules computation

### Requirement: Startup recovery
The system SHALL start a bounded recovery pass after run dependencies are initialized. It SHALL claim eligible pending/running runs and continue only runs with sufficient durable admission or tool-result receipt data; it SHALL not replay an unknown tool side effect.

#### Scenario: Recoverable pending run
- **WHEN** startup finds a pending run with persisted initial input and no valid lease
- **THEN** one instance claims the lease and schedules the original initial computation

#### Scenario: Unknown running run
- **WHEN** startup finds a running run without a durable continuation receipt
- **THEN** it does not replay the graph or tool and records a recoverable failure state
