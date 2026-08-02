## ADDED Requirements

### Requirement: Approval gate before mutating operations
The system SHALL provide an `ApprovalGateway` that gates execution of any tool whose `permissions` is `write`, `execute`, or `destructive`. Before such a tool's `execute` runs, the gateway SHALL be consulted; only on user approval (or an applicable allow rule) SHALL execution proceed. Tools with `permissions: read` SHALL bypass the gateway entirely and execute without prompting.

#### Scenario: Read tool bypasses approval
- **WHEN** the router routes a `tool_call` for `fs.read_file` (permission `read`)
- **THEN** no approval prompt is shown and the tool executes immediately

#### Scenario: Write tool prompts for approval
- **WHEN** the router routes a `tool_call` for `fs.write_file` (permission `write`)
- **THEN** the gateway presents an approval prompt before `execute` runs

### Requirement: Three approval outcomes
The approval prompt SHALL offer exactly three choices: "允许" (allow this once / this session), "始终允许" (always allow, persisted to configuration), and "拒绝" (deny). Selecting "拒绝" SHALL cause the tool result to be `status: 'cancelled'` with a denial reason, and `execute` SHALL NOT run.

#### Scenario: User denies a write
- **WHEN** the user selects "拒绝" for an `fs.write_file` call
- **THEN** the tool returns `{ status: 'cancelled', error: '用户拒绝执行' }` and the file is not written

#### Scenario: User allows once
- **WHEN** the user selects "允许" for an `fs.delete_file` call
- **THEN** the tool executes, and the next `fs.delete_file` call in the same session still prompts

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
