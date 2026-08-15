# approval-gateway Specification

## Purpose
TBD
## Requirements
### Requirement: Approval gate before mutating operations
The `ApprovalGateway` SHALL derive approval behavior from the registered tool permission matrix: `read` bypasses approval, `write` and `execute` require approval, and `destructive` requires approval plus a second confirmation when the operation is irreversible. It SHALL require a matching local scoped grant before bypassing a prompt, and SHALL enforce this locally regardless of the cloud `require_approval` value.

#### Scenario: Destructive operation requires two confirmations
- **WHEN** a destructive tool is routed without an applicable allow rule
- **THEN** the gateway requests approval and a second confirmation before execution

### Requirement: Three approval outcomes
The approval prompt SHALL offer allow, always allow, and deny. Deny SHALL return `status: 'cancelled'` with a reason, SHALL NOT execute the tool, and SHALL be classified as non-retryable for cloud continuation.

#### Scenario: Denial does not cause a loop
- **WHEN** the user denies a tool call
- **THEN** the local plugin sends one cancelled result and the cloud does not automatically repeat the denied call

### Requirement: Session-level allow memory
When the user selects "允许", the gateway SHALL remember the approval for that tool name within the current session, so subsequent calls to the same tool in that session proceed without re-prompting. Session-level allow SHALL NOT persist across sessions.

#### Scenario: Session allow suppresses re-prompt
- **WHEN** the user allowed `fs.write_file` once this session and a second `fs.write_file` call arrives
- **THEN** the second call executes without an approval prompt

### Requirement: Persistent scoped approval via configuration
When the user selects "始终允许", the gateway SHALL persist an expiring record containing workspace identity, tool name, normalized resource pattern, optional command pattern, and policy version. A record SHALL auto-approve only matching future requests. Existing `alwaysAllowTools` entries MAY be read for compatibility but SHALL NOT be written for new approvals.

#### Scenario: Scoped always-allow persists across sessions
- **WHEN** the user selects "始终允许" for `fs.move_file` on a resource and a new session is created later
- **THEN** only the same workspace and resource scope execute without prompting while unrelated resources still require approval

#### Scenario: Pre-configured always-allow auto-approves
- **WHEN** `yunxiaoAgent.alwaysAllowTools` contains `fs.write_file` and a write call arrives
- **THEN** the gateway auto-approves without showing a prompt

### Requirement: Approval prompt content
The approval prompt SHALL identify the tool name and a concise, human-readable summary of its arguments (e.g. the target path for file tools), so the user can make an informed decision. For overwrite-prone operations (write to existing file, delete, move-over-existing), the prompt SHALL indicate the destructive/overwrite nature.

#### Scenario: Overwrite indicated in prompt
- **WHEN** `fs.write_file` targets an existing file
- **THEN** the approval prompt indicates the file will be overwritten

### Requirement: Full-access automatic approval for non-deletion operations
When the workspace approval mode is `full-access`, the `ApprovalGateway` SHALL return `allow` for a non-deletion operation that reaches the gateway without presenting a user prompt. It SHALL make this decision only after the caller's local validation and security controls have allowed the operation, SHALL not create a session or durable grant for that decision, and SHALL log the mode, tool name, and session identifier.

#### Scenario: Write operation is auto-approved in full access
- **WHEN** a validated non-deletion write tool reaches the gateway while the workspace mode is `full-access`
- **THEN** the gateway returns `allow` without an approval card or VS Code approval prompt

#### Scenario: Switching off full access restores normal behavior
- **WHEN** a workspace mode changes from `full-access` to `request`
- **THEN** a later non-read operation follows the existing scoped-grant, session-grant, and prompt behavior

### Requirement: Full access never bypasses deletion confirmation
The `ApprovalGateway` SHALL NOT auto-approve an operation identified as deletion-related when the workspace mode is `full-access`. A destructive deletion operation SHALL retain the existing approval and second-confirmation behavior.

#### Scenario: Destructive file deletion still requires confirmation
- **WHEN** a destructive file deletion reaches the gateway while the workspace mode is `full-access`
- **THEN** the gateway requests the required user confirmation before execution

