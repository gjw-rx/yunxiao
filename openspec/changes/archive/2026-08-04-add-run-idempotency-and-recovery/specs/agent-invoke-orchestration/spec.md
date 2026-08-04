## ADDED Requirements

### Requirement: Tool-result retry uses durable run receipt
The tool-result submission flow SHALL use the run-level durable receipt before invoking continuation. Process-local duplicate tracking SHALL NOT be the authority for a retry after a restart or on a different application instance.

#### Scenario: Retry after restart
- **WHEN** an accepted tool result is retried after the application restarts
- **THEN** the system identifies its persisted receipt and does not inject or continue it again
