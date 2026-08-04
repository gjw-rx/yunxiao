## ADDED Requirements

### Requirement: Stable compute events use the Run sequence log
The compute service SHALL persist each emitted public protocol event to the target Run's event log before that event is observable through a Run subscription.

#### Scenario: Content event is persisted before delivery
- **WHEN** the graph emits a public `content` event
- **THEN** its complete protocol object is committed as an AgentRunEvent before a subscriber receives it

#### Scenario: Tool call is replayable
- **WHEN** the graph emits a local `tool_call`
- **THEN** the complete tool-call payload and following `interrupted` status event are committed together with consecutive Run-local sequences and can be replayed after disconnect

### Requirement: Lifecycle status and sequence advance atomically
The system SHALL lock the Run row and commit a lifecycle status change, its `run_status` event, and the next sequence cursor in one transaction.

#### Scenario: Terminal status is committed with its event
- **WHEN** a running Run completes or fails
- **THEN** the terminal status and corresponding ordered status event become visible together

#### Scenario: Failed status-event write rolls back lifecycle
- **WHEN** writing a lifecycle event fails
- **THEN** neither the status change nor its sequence cursor advancement is committed

### Requirement: Subscription reads are exclusive-cursor based
Every replay or live-subscription read SHALL use the existing `sequence > after_sequence` rule and SHALL preserve ascending order without reconstructing sequence from timestamps or payload content.

#### Scenario: Polling observes another producer
- **WHEN** another process commits events after the subscriber's current cursor
- **THEN** the next database cursor read returns those events in sequence order
