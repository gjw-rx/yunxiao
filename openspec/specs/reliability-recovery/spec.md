# reliability-recovery Specification

## Purpose
Define bounded recovery, cancellation, timeout cleanup, and conflict detection for local tool execution and result submission.

## Requirements

### Requirement: Classified failure recovery
The local plugin SHALL classify tool failures as retryable or non-retryable and SHALL include a user-readable reason in the `tool_result`. Network-connect failures and transient timeouts MAY be retried up to three attempts; permission, path, validation, cancellation, and destructive-policy failures SHALL NOT be automatically retried.

#### Scenario: Transient connection failure retries
- **WHEN** a result submission fails before the continuation stream starts with a network or 5xx error
- **THEN** the plugin retries with bounded backoff and eventually reports a friendly error if all attempts fail

#### Scenario: Path failure is not retried
- **WHEN** a tool fails because its path is outside the workspace
- **THEN** the plugin posts one error result and does not repeat the same tool call

### Requirement: Cancellation and timeout cleanup
The session manager SHALL abort active streams and local executions on user cancellation or timeout, clear pending state, and post at most one matching result per call. A cancellation SHALL use `cancelled`; an execution timeout SHALL use `error` with a timeout reason.

#### Scenario: Cancelled tool is finalized once
- **WHEN** the user cancels while a local tool is running
- **THEN** the tool is aborted, one cancelled result is posted, and the session returns to idle without a late success result

### Requirement: Concurrent modification detection
A mutating local tool SHALL be able to compare an expected file/resource version before applying its change. When the version differs, it SHALL return a conflict error without applying the mutation.

#### Scenario: Stale edit is rejected
- **WHEN** a file changed after the agent read it and before an edit is applied
- **THEN** the edit returns a conflict error and leaves the current file unchanged
