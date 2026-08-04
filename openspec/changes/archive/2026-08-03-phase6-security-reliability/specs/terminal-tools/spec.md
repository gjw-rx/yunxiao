# terminal-tools Specification

## MODIFIED Requirements

### Requirement: Execution timeout
The `terminal.exec` tool SHALL enforce a configurable timeout. On timeout it SHALL terminate the process with the existing grace period, return `status: "error"`, include partial output only after common result governance, and mark the failure retryable only when re-running the command is safe.

#### Scenario: Timeout result is bounded
- **WHEN** a command exceeds its timeout and produced a large partial output
- **THEN** the process is terminated and the returned error result is bounded and carries a timeout reason

### Requirement: Execution cancellation
The `terminal.exec` tool SHALL accept a cancellation signal. On cancellation it SHALL terminate the process, return `status: "cancelled"`, and SHALL NOT be retried automatically by the session or cloud.

#### Scenario: Cancelled command is not replayed
- **WHEN** the user aborts a running terminal command
- **THEN** the process is terminated, one cancelled result is returned, and the command is not spawned again

### Requirement: Output truncation
The `terminal.exec` tool SHALL apply the common result-governance policy to stdout and stderr, preserving useful error context and marking `truncated` metadata when bounded.

#### Scenario: Large output carries marker
- **WHEN** a command exceeds the configured output budget
- **THEN** the result contains bounded output and an explicit truncation marker for the cloud Agent
