# approval-gateway Specification

## MODIFIED Requirements

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
