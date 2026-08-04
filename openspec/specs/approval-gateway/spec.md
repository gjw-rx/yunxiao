# approval-gateway Specification

## Purpose
TBD
## Requirements
### Requirement: Approval gate before mutating operations
The `ApprovalGateway` SHALL derive approval behavior from the registered tool permission matrix: `read` bypasses approval, `write` and `execute` require approval, and `destructive` requires approval plus a second confirmation when the operation is irreversible. This decision SHALL be enforced locally regardless of the cloud `require_approval` value.

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

### Requirement: Persistent always-allow via configuration
When the user selects "始终允许", the gateway SHALL add the tool name to the `yunxiaoAgent.alwaysAllowTools` configuration array, so the tool is auto-approved in future sessions. On gateway construction, tools already present in `alwaysAllowTools` SHALL be auto-approved without prompting.

#### Scenario: Always-allow persists across sessions
- **WHEN** the user selects "始终允许" for `fs.move_file` and a new session is created later
- **THEN** `fs.move_file` calls in the new session execute without prompting because the name is in `alwaysAllowTools`

#### Scenario: Pre-configured always-allow auto-approves
- **WHEN** `yunxiaoAgent.alwaysAllowTools` contains `fs.write_file` and a write call arrives
- **THEN** the gateway auto-approves without showing a prompt

### Requirement: Approval prompt content
The approval prompt SHALL identify the tool name and a concise, human-readable summary of its arguments (e.g. the target path for file tools), so the user can make an informed decision. For overwrite-prone operations (write to existing file, delete, move-over-existing), the prompt SHALL indicate the destructive/overwrite nature.

#### Scenario: Overwrite indicated in prompt
- **WHEN** `fs.write_file` targets an existing file
- **THEN** the approval prompt indicates the file will be overwritten
