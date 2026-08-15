## ADDED Requirements

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
