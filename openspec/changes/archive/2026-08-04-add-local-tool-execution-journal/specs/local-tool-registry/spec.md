## MODIFIED Requirements

### Requirement: Approval gating for write/destructive tools
The router SHALL consult the `ApprovalGateway` before executing any tool whose `permissions` is `write`, `execute`, or `destructive`. When approval is denied, the router SHALL return a `ToolResult` with `status: 'cancelled'` and SHALL NOT invoke the tool's `execute`. Tools with `permissions: read` SHALL execute without consultation. The router SHALL base this decision on the tool's declared `permissions`, not on the inbound `tool_call.require_approval` flag (defense in depth: local is the security boundary). For a permitted non-read tool, the router SHALL consult the local execution journal before invoking `execute`; a terminal receipt MUST be reused and a non-terminal receipt MUST block execution with an unknown non-retryable result.

#### Scenario: Write tool gated and approved
- **WHEN** the router routes a `tool_call` for `fs.write_file` (permission `write`) and the user approves
- **THEN** the router records or resolves its execution receipt before it invokes `execute`

#### Scenario: Destructive tool gated and denied
- **WHEN** the router routes a `tool_call` for `fs.delete_file` (permission `destructive`) and the user denies
- **THEN** the router returns `{ status: 'cancelled', error: '用户拒绝执行' }` and `execute` is not called

#### Scenario: Read tool not gated
- **WHEN** the router routes a `tool_call` for `fs.read_file` (permission `read`)
- **THEN** the gateway is not consulted and `execute` runs immediately

#### Scenario: Local gates regardless of cloud flag
- **WHEN** a `tool_call` for a `write` tool arrives with `require_approval: false`
- **THEN** the router still consults the gateway because the tool's declared permission is `write`

#### Scenario: Interrupted prior execution is retried
- **WHEN** the router receives a permitted non-read call with an existing non-terminal execution receipt
- **THEN** the router returns an unknown non-retryable result and does not invoke `execute`
