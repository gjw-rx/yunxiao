## ADDED Requirements

### Requirement: Run compute is independent from subscriptions
The system SHALL execute an admitted Run in a background computation owned by the application, and closing any HTTP/SSE subscription MUST NOT cancel or otherwise finalize that computation.

#### Scenario: Subscriber disconnects during computation
- **WHEN** an SSE subscriber disconnects while its Run is still producing events
- **THEN** the background computation continues, persists subsequent events, and reaches its graph-derived lifecycle state

#### Scenario: Run has no subscriber
- **WHEN** a Run is admitted and no client subscribes to its events
- **THEN** the Run still executes and persists its output and terminal state

### Requirement: Idempotent compute admission
The v2 command API MUST require a `client_request_id` scoped to `session_id`, SHALL return the stable `run_id`, and SHALL start computation only when the Run is newly admitted.

#### Scenario: First command starts computation
- **WHEN** a valid command uses a new `(session_id, client_request_id)`
- **THEN** one Run is created, its `run_id` is returned, and one background computation is started

#### Scenario: Retried command reuses Run
- **WHEN** the same `(session_id, client_request_id)` is submitted again
- **THEN** the original `run_id` and current status are returned without archiving the user message or starting computation again

### Requirement: Compute lifecycle convergence
The compute service SHALL transition a Run from `pending` to `running`, then to `interrupted` when local tool input is required, `completed` after a normal final response, or `failed` after an unhandled computation error.

#### Scenario: Local tool interrupts computation
- **WHEN** a running graph emits a `tool_call` event
- **THEN** that event is persisted and the Run becomes `interrupted`

#### Scenario: Final response completes computation
- **WHEN** a running graph ends without a pending local tool call
- **THEN** all output events are persisted and the Run becomes `completed`

#### Scenario: Computation fails
- **WHEN** the graph or event persistence raises an unhandled error
- **THEN** the Run becomes `failed`, a sanitized failure status event is persisted, and the error is logged with its stack

### Requirement: Tool-result continuation is Run-scoped
The v2 continuation command SHALL require a `run_id` in `interrupted` state and MUST reject a duplicate or stale continuation before starting another graph resume.

#### Scenario: Valid continuation resumes one Run
- **WHEN** tool results target an `interrupted` Run
- **THEN** the Run transitions to `running` and one background resume computation starts

#### Scenario: Duplicate continuation is rejected
- **WHEN** tool results target a Run that is already `running`, `completed`, `failed`, or `cancelled`
- **THEN** no new resume computation starts and the caller receives a lifecycle conflict

### Requirement: Ordered replay and live subscription
The v2 event API SHALL accept an exclusive `after_sequence` cursor, replay all later committed events in ascending sequence order, continue observing newly committed events, and close only after the terminal Run state has been observed and the cursor is caught up.

#### Scenario: Reconnect replays a gap
- **WHEN** events 1 through 8 are committed and a client reconnects with `after_sequence=5`
- **THEN** it receives events 6, 7, and 8 in order before any later live event

#### Scenario: Subscriber catches a terminal Run
- **WHEN** the Run reaches a terminal state while a subscriber is connected
- **THEN** the subscriber receives the terminal status event and closes after all committed events have been delivered

#### Scenario: Multiple subscribers observe one computation
- **WHEN** two clients subscribe to the same Run from different cursors
- **THEN** each receives the ordered suffix for its own cursor and neither subscription starts or cancels computation

### Requirement: Versioned Run API
The system SHALL expose Run command, status, continuation, and event subscription endpoints whose responses identify the stable `run_id`; the event subscription SHALL expose each event's `sequence`, `event_type`, and persisted `payload`.

#### Scenario: Start response identifies Run
- **WHEN** a v2 Run command is admitted
- **THEN** the response contains `run_id`, lifecycle status, and whether a new Run was created

#### Scenario: Status reports replay cursor
- **WHEN** a caller reads a Run after events have been committed
- **THEN** the response contains the Run status and the latest committed sequence cursor

### Requirement: Message archival is compute-owned
The system SHALL archive the user message once for a newly admitted Run and SHALL archive assistant output from the background computation independently of subscriber count or connection lifetime.

#### Scenario: Duplicate admission does not duplicate user history
- **WHEN** a command retry resolves to an existing Run
- **THEN** no second user message is appended

#### Scenario: Disconnect does not lose assistant history
- **WHEN** the only subscriber disconnects before final output
- **THEN** the background computation still archives the assistant output it completes
