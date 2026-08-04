## ADDED Requirements

### Requirement: Lightweight persistent Agent Run
The system SHALL persist each admitted Agent execution as one `AgentRun` containing only a stable `run_id`, `session_id`, `client_request_id`, lifecycle `status`, optional `last_checkpoint_id`, and standard creation/update timestamps.

#### Scenario: Run is stored without duplicating graph state
- **WHEN** an Agent Run is persisted
- **THEN** the Run row contains no graph step, tool call, event payload, model response, or token stream data

#### Scenario: Stable Run identifier is unique
- **WHEN** two Run rows use the same `run_id`
- **THEN** the database rejects the second row

#### Scenario: Run uses only logical associations
- **WHEN** the AgentRun metadata is inspected
- **THEN** `session_id` and `last_checkpoint_id` have indexes where required and no database foreign-key or cascade relationship

### Requirement: Idempotent Run admission
The system MUST require a `client_request_id` for every admitted Run and SHALL enforce uniqueness for `(session_id, client_request_id)`.

#### Scenario: Retried request returns the existing Run
- **WHEN** `create_or_get` is called again with an existing `session_id` and `client_request_id`
- **THEN** it returns the original Run and reports that no new Run was created

#### Scenario: Concurrent admission creates one Run
- **WHEN** multiple processes concurrently admit the same `session_id` and `client_request_id`
- **THEN** exactly one Run row is committed and all callers resolve to that same Run

#### Scenario: Request identifier is scoped to a session
- **WHEN** two different sessions use the same `client_request_id`
- **THEN** each session can own one distinct Run

### Requirement: Controlled Run lifecycle
The Run service SHALL support `pending`, `running`, `interrupted`, `completed`, `failed`, and `cancelled` statuses and MUST reject transitions whose expected source status no longer matches the stored Run.

#### Scenario: Expected transition succeeds
- **WHEN** a Run in `pending` is transitioned to `running` with `pending` as an expected source
- **THEN** the status and update timestamp are persisted

#### Scenario: Stale transition is rejected
- **WHEN** a caller attempts a transition using an expected source status that does not match the stored Run
- **THEN** the Run remains unchanged and the conflict is observable to the caller

### Requirement: Logical checkpoint correlation
The Run service SHALL record the latest confirmed LangGraph `checkpoint_id` as `last_checkpoint_id` without copying checkpoint state into AgentRun and without declaring a foreign key to LangGraph tables.

#### Scenario: Checkpoint pointer is updated
- **WHEN** the application confirms a new LangGraph checkpoint for a Run
- **THEN** the Run stores that checkpoint ID and its lifecycle status in one caller-controlled transaction

#### Scenario: Graph state is read from LangGraph
- **WHEN** a caller needs current nodes, pending tasks, interrupts, messages, or final graph output
- **THEN** the system reads the LangGraph checkpointer rather than AgentRun

### Requirement: Recoverable Run scanning
The Run service SHALL list `pending` and `running` Runs as recovery candidates without automatically advancing their graphs.

#### Scenario: Restart scan identifies candidates
- **WHEN** the service performs a recovery scan after startup
- **THEN** all persisted `pending` and `running` Runs are returned with their session and checkpoint identifiers

#### Scenario: Interrupted Run is not auto-advanced
- **WHEN** a Run is in `interrupted` state waiting for external tool or human input
- **THEN** the recovery scan does not classify it as automatically runnable

### Requirement: Agent Trace Run correlation
The system SHALL extend AgentTrace with nullable `run_id` and `tool_call_id` logical association fields while preserving all existing trace content and best-effort failure behavior.

#### Scenario: Model trace is associated with a Run
- **WHEN** a model call executes with an application Run context
- **THEN** its AgentTrace row stores the application `run_id`

#### Scenario: Tool trace preserves call identity
- **WHEN** a tool call with a LangChain/LangGraph tool call ID is traced
- **THEN** its AgentTrace row stores both the application `run_id` and `tool_call_id`

#### Scenario: Existing trace remains readable
- **WHEN** a pre-change AgentTrace row has no Run or tool-call association
- **THEN** it remains valid with nullable association columns

#### Scenario: Runnable event ID is not used as application Run identity
- **WHEN** an `astream_events` callback contains its own generated `event["run_id"]`
- **THEN** that value is not stored as the application AgentRun `run_id`

### Requirement: Transaction-neutral persistence adapters
The AgentRun repository SHALL use asynchronous SQLAlchemy operations without committing transactions or suppressing integrity errors.

#### Scenario: Caller controls commit and rollback
- **WHEN** a caller performs multiple Run operations through the repository
- **THEN** the caller can commit or roll back the complete unit of work

#### Scenario: Integrity conflict is observable
- **WHEN** a repository write violates a Run uniqueness constraint
- **THEN** the integrity error is available to RunService for idempotent conflict handling

### Requirement: Run schema initialization
The system SHALL register the AgentRun model in shared SQLAlchemy metadata and SHALL add nullable Run correlation columns to existing AgentTrace storage without changing existing invoke records.

#### Scenario: Empty database initialization
- **WHEN** database initialization runs against an empty supported database
- **THEN** exactly one new AgentRun table and the required Run/Trace constraints and indexes are created

#### Scenario: Existing data is preserved
- **WHEN** initialization runs against a database containing invoke sessions, messages, and traces
- **THEN** existing rows remain accessible and Trace association fields default to null

### Requirement: No persisted Run event timeline
The system SHALL use LangGraph checkpoints for reconnecting to current or final graph state and SHALL NOT claim sequence-based replay of previously emitted token or SSE chunks.

#### Scenario: Reconnect reads durable state
- **WHEN** a client reconnects after losing a stream
- **THEN** the service can resolve the Run and read its current or final state from the LangGraph checkpointer

#### Scenario: Exact stream replay is requested
- **WHEN** a caller requests token or SSE events emitted after a prior sequence cursor
- **THEN** the current capability reports that exact event replay is unsupported rather than reconstructing or guessing the missing stream
