## MODIFIED Requirements

### Requirement: Multi-round SSE continuation
A single user message MAY trigger multiple graph computation rounds under one stable cloud `run_id`: when the cloud persists a `tool_call` event, the Run becomes `interrupted`; after the local tool result is posted for that Run, cloud computation resumes in the background. The session manager SHALL subscribe to ordered Run events and SHALL treat both "user sends message" and "tool result posted" as commands followed by subscription, not as ownership of cloud computation.

#### Scenario: Tool call triggers continuation
- **WHEN** the cloud Run persists a `tool_call` for `fs.read_file` and becomes `interrupted`
- **THEN** the session manager executes the local tool, posts the result for the same `run_id`, and subscribes after its last consumed sequence

#### Scenario: Multiple sequential tool calls in one turn
- **WHEN** the Run issues tool call A, then after its result another tool call B, before producing a final answer
- **THEN** both continuation commands target the same `run_id`, and the session manager advances one ordered sequence cursor across all rounds

#### Scenario: Subscription disconnects between rounds
- **WHEN** the event subscription disconnects after a tool result command has been accepted
- **THEN** cloud computation continues independently and the session manager can reconnect after its last consumed sequence

### Requirement: Explicit local run terminal states
The session manager SHALL expose exactly one terminal outcome for each current local subscription attempt: `completed`, `cancelled`, `failed`, or `disconnected`. A cloud `run_status=completed` event followed by a caught-up stream SHALL produce `completed`; an explicit user cancellation SHALL produce `cancelled`; a cloud failed status, server error, or non-recoverable protocol error SHALL produce `failed`; and an unexpected transport loss before observing a cloud terminal status SHALL produce `disconnected`. A local `disconnected` outcome SHALL NOT imply that the cloud Run stopped or failed.

#### Scenario: Cloud Run completes
- **WHEN** the subscriber receives the cloud Run's `completed` status event and consumes all events through that sequence
- **THEN** the local run emits one `completed` terminal state

#### Scenario: User cancels current subscription
- **WHEN** the user cancels the current local run
- **THEN** the local run emits one `cancelled` terminal state and SHALL NOT infer that cloud computation was cancelled

#### Scenario: Cloud Run fails
- **WHEN** the subscriber receives the cloud Run's `failed` status event
- **THEN** the local run emits one `failed` terminal state containing a user-readable reason

#### Scenario: Transport disconnects unexpectedly
- **WHEN** the current subscription loses its network stream before a cloud terminal status is observed
- **THEN** the local run emits one `disconnected` terminal state and retains its last consumed sequence for replay

#### Scenario: Duplicate result has no continuation response
- **WHEN** a tool result submission receives a valid duplicate acknowledgement rather than owning a continuation stream
- **THEN** the session manager reconnects to the existing `run_id` after its last consumed sequence instead of claiming completion
