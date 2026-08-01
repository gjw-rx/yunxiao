## ADDED Requirements

### Requirement: BaseTool contract
The system SHALL define an abstract `BaseTool` that every local tool implements. It SHALL expose `execute(args, context)` returning a `ToolResult`, `validate(args)` checking arguments against the tool's schema before execution, and a `permission` level declaring whether the tool is read-only or requires approval. In Phase 1 only read-only tools are implemented, so no approval gateway is wired.

#### Scenario: Validate rejects invalid arguments
- **WHEN** `fs.read_file` is called without a `path` argument
- **THEN** `validate` returns an error before `execute` runs

#### Scenario: Execute returns a ToolResult
- **WHEN** `fs.read_file` executes successfully
- **THEN** it returns a `ToolResult` with `status: 'success'` and the file content in `result`

### Requirement: fs.read_file tool
The system SHALL implement `fs.read_file` that reads a UTF-8 text file located via the path guard. It SHALL resolve the path through the path guard (workspace root + traversal/symlink/sensitive checks), enforce a maximum file size (default 1 MB, configurable), detect binary files and refuse to return them as text, and return the content as the tool result.

#### Scenario: Read a small text file
- **WHEN** the agent calls `fs.read_file` with `path: 'src/extension.ts'` and the file exists and is text under the size limit
- **THEN** the tool returns `status: 'success'` with the file content as a string

#### Scenario: Read a non-existent file
- **WHEN** `fs.read_file` is called with a path that does not exist
- **THEN** the tool returns `status: 'error'` with a clear file-not-found error

#### Scenario: File exceeds size limit
- **WHEN** `fs.read_file` is called on a file larger than the configured maximum (default 1 MB)
- **THEN** the tool returns `status: 'error'` indicating the file exceeds the size limit, and does not return content

#### Scenario: Binary file detection
- **WHEN** `fs.read_file` is called on a binary file (e.g. a PNG)
- **THEN** the tool returns `status: 'error'` (or a placeholder indication) stating the file is binary and is not returned as text

#### Scenario: Path rejected by guard
- **WHEN** `fs.read_file` is called with a traversal path like `../../../etc/passwd`
- **THEN** the path guard rejects it and the tool returns `status: 'error'` with the guard's reason

### Requirement: Read-only permission
`fs.read_file` SHALL declare permission `read` and SHALL NOT mutate the filesystem. Because it is read-only, it SHALL execute in Phase 1 without user approval.

#### Scenario: No approval required for read
- **WHEN** the agent calls `fs.read_file`
- **THEN** the tool executes immediately without an approval prompt

### Requirement: Sensitive file redaction on read
When `fs.read_file` reads a file flagged sensitive by the path guard, the returned content SHALL be redacted for likely secrets (API keys, passwords, tokens) via pattern matching before being placed in the tool result.

#### Scenario: .env content redacted
- **WHEN** `fs.read_file` reads `.env` containing `API_KEY=abc123`
- **THEN** the returned content has the secret value redacted (e.g. `API_KEY=***`) and a warning is surfaced
