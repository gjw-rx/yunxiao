# security-boundary Specification

## Purpose
Define the centralized checks that prevent unsafe local tool execution and protect governed tool results before cloud upload.

## Requirements

### Requirement: Pre-execution security audit
The local plugin SHALL run a centralized security audit before every local tool execution. The audit SHALL check workspace/path boundaries, sensitive resources, dangerous commands, declared permission, and an optional expected resource version. A rejected audit SHALL return `status: "error"` or `status: "cancelled"` according to the rejection type and SHALL NOT execute the tool.

#### Scenario: Traversal is rejected centrally
- **WHEN** a local file tool receives a path outside the workspace
- **THEN** the audit rejects the call before filesystem access and returns a clear reason

#### Scenario: Dangerous command is rejected centrally
- **WHEN** a terminal tool receives a command classified as dangerous
- **THEN** the audit returns `cancelled` without spawning a process or prompting again

### Requirement: Unified tool result governance
The local plugin SHALL apply a common result-governance step before sending any tool result to the cloud. It SHALL skip binary payloads, truncate oversized text, redact high-confidence secrets, and attach metadata indicating truncation or redaction. The original sensitive or oversized content SHALL NOT be sent to the cloud.

#### Scenario: Secret is redacted before upload
- **WHEN** a tool result contains a high-confidence API key or password assignment
- **THEN** the uploaded result contains a redacted placeholder and `metadata.redacted` is true

#### Scenario: Oversized result is truncated
- **WHEN** a tool returns content beyond the configured result budget
- **THEN** the uploaded result is bounded, includes a truncation marker, and the cloud can continue without receiving the full payload

### Requirement: Permission matrix enforcement
The local plugin SHALL declare every registered tool as `read`, `write`, `execute`, or `destructive`. The router SHALL require approval for `write`, `execute`, and `destructive`; destructive operations SHALL support an additional confirmation step. The cloud-provided `require_approval` flag SHALL NOT weaken this local decision.

#### Scenario: Cloud flag cannot bypass local approval
- **WHEN** a write tool arrives with `require_approval: false`
- **THEN** the local router still applies the tool's declared permission and requests approval
