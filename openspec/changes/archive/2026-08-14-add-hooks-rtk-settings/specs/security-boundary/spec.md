## MODIFIED Requirements

### Requirement: Pre-execution security audit
The local plugin SHALL run a centralized security audit before every local tool execution. The audit SHALL check workspace/path boundaries, sensitive resources, dangerous commands, declared permission, and an optional expected resource version. When a trusted Hook transforms tool arguments, the audit SHALL independently evaluate both the immutable original call and the validated final call; a rejection of either SHALL return `status: "error"` or `status: "cancelled"` according to the rejection type and SHALL NOT execute the tool. A rejected audit SHALL NOT be bypassed by a Hook, approval decision, or transformed argument.

#### Scenario: Traversal is rejected centrally
- **WHEN** a local file tool receives a path outside the workspace
- **THEN** the audit rejects the call before filesystem access and returns a clear reason

#### Scenario: Dangerous command is rejected centrally
- **WHEN** a terminal tool receives a command classified as dangerous
- **THEN** the audit returns `cancelled` without spawning a process or prompting again

#### Scenario: Original command remains subject to audit after transformation
- **WHEN** a trusted Hook transforms a terminal command and the original command violates a centralized dangerous-command rule
- **THEN** the audit rejects the tool call and the transformed command is not executed

#### Scenario: Final command remains subject to audit after transformation
- **WHEN** a trusted Hook returns final tool arguments that violate a centralized path, sensitive-resource or dangerous-command rule
- **THEN** the audit rejects the tool call and no approval prompt can allow execution
