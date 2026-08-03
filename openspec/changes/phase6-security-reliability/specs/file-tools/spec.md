# file-tools Specification

## MODIFIED Requirements

### Requirement: BaseTool contract
The system SHALL define an abstract `BaseTool` that every local tool implements. It SHALL expose `execute(args, context)` returning a `ToolResult`, `validate(args)` checking arguments before execution, a `permission` level, and a common result-governance hook that bounds output, skips binary payloads, redacts secrets, and preserves conflict/error metadata before upload.

#### Scenario: Common governance applies to every tool
- **WHEN** any local tool returns an oversized or secret-bearing result
- **THEN** the BaseTool boundary governs the result before the protocol layer sends it to the cloud

### Requirement: Path safety for all file tools
Every `fs.*` tool SHALL resolve target paths through the path guard and security audit before filesystem access. Traversal, symlink escape, sensitive-policy violations, and stale expected versions SHALL return an error with a clear reason and SHALL NOT touch the filesystem.

#### Scenario: Concurrent edit conflict is safe
- **WHEN** a mutating file tool receives an expected version that no longer matches
- **THEN** it returns a conflict error and does not modify the file
