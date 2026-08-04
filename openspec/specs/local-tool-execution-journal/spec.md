# local-tool-execution-journal Specification

## Purpose
TBD - created by archiving change add-local-tool-execution-journal. Update Purpose after archive.
## Requirements
### Requirement: Persistent non-idempotent execution receipt
The extension SHALL persist an execution receipt in workspace state for each local tool with `write`, `execute`, or `destructive` permission after approval and security audit permit it and before it invokes the tool implementation. A receipt MUST be identified by a Run ID and call ID when a Run ID is available, and by session ID and call ID for legacy streams. The receipt MUST record the tool name and `started` state without storing the tool arguments.

#### Scenario: Side-effect tool starts
- **WHEN** an approved local `fs.write_file` call is routed for the first time
- **THEN** the extension persists its `started` receipt before calling the tool implementation

#### Scenario: Read tool bypasses journal
- **WHEN** a local tool with `read` permission is routed
- **THEN** the extension does not create an execution receipt and retains its existing execution behavior

### Requirement: Terminal receipt result reuse
The extension SHALL persist the final ToolResult after a journaled tool completes or rejects. When a later route receives the same execution identity with a terminal receipt, it MUST return the stored result and MUST NOT invoke the tool implementation again.

#### Scenario: Completed call is delivered again
- **WHEN** an approved write call with a stored successful terminal receipt is routed again with the same execution identity
- **THEN** the extension returns the stored successful result without executing the tool a second time

#### Scenario: Tool implementation rejects
- **WHEN** a journaled tool implementation rejects after its started receipt is stored
- **THEN** the extension stores an error terminal receipt before propagating the error to the existing session error flow

### Requirement: Unknown execution blocks replay
The extension SHALL treat an existing `started` receipt as an unknown execution outcome. It MUST return a ToolResult with `status: error`, `metadata.retryable: false`, and `metadata.execution_state: unknown`, and MUST NOT execute the tool implementation or overwrite the receipt.

#### Scenario: Extension host restarts during a write
- **WHEN** a write tool's `started` receipt exists without a terminal result when the same call is encountered after restoration
- **THEN** the extension returns an unknown non-retryable result and does not replay the write

