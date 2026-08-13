## ADDED Requirements

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
