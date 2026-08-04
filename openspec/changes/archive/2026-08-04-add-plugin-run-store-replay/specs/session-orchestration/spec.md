## MODIFIED Requirements

### Requirement: Multi-round SSE continuation
A single user message MAY trigger multiple graph computation rounds under one stable cloud `run_id`: when the cloud persists a `tool_call` event, the Run becomes `interrupted`; after the local tool result is posted for that Run, cloud computation resumes in the background. The session manager SHALL persist and consume ordered Run events through a session-owned exclusive sequence cursor and SHALL treat both "user sends message" and "tool result posted" as commands followed by subscription, not as ownership of cloud computation. A reconnect or extension-host restoration SHALL subscribe after the stored cursor and SHALL NOT execute a restored local tool call automatically.

#### Scenario: Tool call triggers continuation
- **WHEN** the cloud Run persists a `tool_call` for `fs.read_file` and becomes `interrupted`
- **THEN** the session manager records the event cursor, executes the newly received local tool, posts the result for the same `run_id`, and subscribes after its last consumed sequence

#### Scenario: Multiple sequential tool calls in one turn
- **WHEN** the Run issues tool call A, then after its result another tool call B, before producing a final answer
- **THEN** both continuation commands target the same `run_id`, and the session manager advances one ordered sequence cursor across all rounds

#### Scenario: Subscription disconnects between rounds
- **WHEN** the event subscription disconnects after a tool result command has been accepted
- **THEN** cloud computation continues independently and the session manager can reconnect after its last consumed sequence

#### Scenario: Extension host restores an interrupted Run
- **WHEN** the extension host restarts with an interrupted Run and a stored cursor
- **THEN** the session manager subscribes after that cursor and leaves any stored local tool call pending for user-safe recovery
