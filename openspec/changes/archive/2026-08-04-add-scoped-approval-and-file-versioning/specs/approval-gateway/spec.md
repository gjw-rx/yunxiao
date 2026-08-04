## MODIFIED Requirements

### Requirement: Approval gate before mutating operations
The `ApprovalGateway` SHALL derive approval behavior from the registered tool's local permission and SHALL require a matching local scoped grant before bypassing a prompt for any non-read operation. Cloud-provided `require_approval` flags SHALL NOT bypass this behavior.

#### Scenario: Write tool prompts for approval
- **WHEN** a `write` permission tool has no matching local scoped grant
- **THEN** the gateway presents an approval prompt before execution

#### Scenario: Cloud flag cannot bypass approval
- **WHEN** a `write` tool arrives with `require_approval: false` and no matching scoped grant
- **THEN** the gateway still requests local approval

### Requirement: Three approval outcomes
The approval prompt SHALL offer allow, always allow, and deny. Allow SHALL create only a session-scoped grant for the current request scope; always allow SHALL persist an expiring scoped grant; deny or prompt dismissal SHALL return a cancelled result without executing the tool.

#### Scenario: Always approval is constrained
- **WHEN** the user selects always allow for a file operation
- **THEN** the gateway persists only the request's workspace and resource scope with an expiration time
