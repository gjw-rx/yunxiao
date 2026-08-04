## ADDED Requirements

### Requirement: Scoped approval record
The extension SHALL persist each durable local approval as a record containing a canonical workspace identity, tool name, normalized resource pattern, optional command pattern, expiration timestamp, and policy version.

#### Scenario: Durable approval for a file edit
- **WHEN** the user selects durable approval for `code.edit` on `src/app.ts` in a workspace
- **THEN** the extension stores a grant limited to that workspace, tool, normalized file path, policy version, and expiration time

### Requirement: Strict scoped-grant matching
The extension SHALL reuse a durable approval only when workspace identity, tool name, policy version, expiry, and the applicable resource and command patterns all match the locally derived request scope.

#### Scenario: Different file is not implicitly approved
- **WHEN** a grant exists for `code.edit` on `src/app.ts` and a call targets `src/config.ts`
- **THEN** the extension prompts for approval instead of reusing the first grant

#### Scenario: Expired grant is not reused
- **WHEN** a matching durable grant has passed its expiration timestamp
- **THEN** the extension prompts for approval and does not execute on the expired grant

### Requirement: Session approvals are resource scoped
The extension SHALL remember a one-time approval only for the same session, tool, workspace, and normalized resource scope.

#### Scenario: Session approval does not cross resources
- **WHEN** a session approves `fs.write_file` for `a.txt` and later calls the same tool for `b.txt`
- **THEN** the later call requires a new approval
