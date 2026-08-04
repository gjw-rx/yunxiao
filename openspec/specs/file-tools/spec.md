# file-tools Specification

## Purpose
TBD - created by archiving change phase1-local-tool-calling. Update Purpose after archive.
## Requirements
### Requirement: BaseTool contract
The system SHALL define an abstract `BaseTool` that every local tool implements. It SHALL expose `execute(args, context)` returning a `ToolResult`, `validate(args)` checking arguments before execution, a `permission` level, and a common result-governance hook that bounds output, skips binary payloads, redacts secrets, and preserves conflict/error metadata before upload.

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

### Requirement: fs.write_file tool
The system SHALL implement `fs.write_file` (permission `write`, site `local`) that writes UTF-8 text content to a file located via the path guard. It SHALL auto-create missing parent directories, write atomically (write to a temporary file in the same directory then rename), and detect when the target already exists (surfacing overwrite intent to the approval prompt). It SHALL integrate the approval gateway (the router gates it before execution).

#### Scenario: Write a new file
- **WHEN** `fs.write_file` is called with a path that does not exist and `content`
- **THEN** parent directories are created, the file is written atomically, and the tool returns `status: 'success'`

#### Scenario: Overwrite existing file
- **WHEN** `fs.write_file` is called with a path that already exists
- **THEN** the file is overwritten atomically and the approval prompt indicates overwrite

#### Scenario: Path rejected by guard
- **WHEN** `fs.write_file` is called with a traversal path
- **THEN** the path guard rejects it and the tool returns `status: 'error'` without writing

### Requirement: fs.list_dir tool
The system SHALL implement `fs.list_dir` (permission `read`, site `local`) that lists entries under a directory resolved via the path guard. It SHALL return each entry's name, type (file/directory), size, and modification time. It SHALL respect `.gitignore` rules (preferably via ripgrep `--files`; otherwise a built-in minimal ignore matcher) and SHALL support filtering by entry type. The default listing SHALL be non-recursive (single level); recursion SHALL be opt-in via a parameter.

#### Scenario: List a directory
- **WHEN** `fs.list_dir` is called with a valid directory path
- **THEN** the tool returns `status: 'success'` with entries containing name, type, size, and mtime

#### Scenario: gitignored entries excluded
- **WHEN** `fs.list_dir` is called on a directory containing `node_modules/` and `node_modules` is gitignored
- **THEN** the returned entries exclude `node_modules`

### Requirement: fs.search_files tool
The system SHALL implement `fs.search_files` (permission `read`, site `local`) that searches file contents. It SHALL prefer ripgrep (`rg`) for performance and `.gitignore` respect, returning matches with surrounding context lines (default 2 before and 2 after). It SHALL support both a regex pattern mode and a glob filename mode. When `rg` is not available, it SHALL fall back to a Node-native search (bounded by file count and size limits to avoid exhaustion).

#### Scenario: Search with regex via ripgrep
- **WHEN** `fs.search_files` is called with a regex pattern and `rg` is available
- **THEN** the tool returns matching locations with context lines

#### Scenario: Fall back when ripgrep missing
- **WHEN** `fs.search_files` is called and `rg` is not on PATH
- **THEN** the tool falls back to Node-native search and still returns matches (bounded)

### Requirement: fs.delete_file tool
The system SHALL implement `fs.delete_file` (permission `destructive`, site `local`) that deletes a file or empty directory resolved via the path guard. It SHALL prefer moving to the system trash (`useTrash: true`) over permanent deletion; when trash is unavailable it SHALL fall back to permanent deletion and annotate the result. It SHALL integrate the approval gateway (destructive permission).

#### Scenario: Delete to trash
- **WHEN** `fs.delete_file` is called on a file and trash is available
- **THEN** the file is moved to trash and the tool returns `status: 'success'`

#### Scenario: Permanent delete fallback
- **WHEN** `fs.delete_file` is called and trash is unavailable
- **THEN** the file is permanently deleted and the result metadata indicates permanent deletion

### Requirement: fs.move_file tool
The system SHALL implement `fs.move_file` (permission `write`, site `local`) that moves/renames a file from a source to a destination, both resolved via the path guard. It SHALL detect when the destination already exists (surfacing overwrite to the approval prompt) and SHALL auto-create missing destination parent directories. It SHALL integrate the approval gateway.

#### Scenario: Move a file
- **WHEN** `fs.move_file` is called with a valid source and a non-existent destination
- **THEN** the file is moved and the tool returns `status: 'success'`

#### Scenario: Move onto existing destination
- **WHEN** `fs.move_file` is called with a destination that already exists
- **THEN** the approval prompt indicates overwrite and, on approval, the destination is replaced

### Requirement: Path safety for all file tools
Every `fs.*` tool SHALL resolve target paths through the path guard and security audit before filesystem access. Traversal, symlink escape, sensitive-policy violations, and stale expected versions SHALL return an error with a clear reason and SHALL NOT touch the filesystem.

#### Scenario: Concurrent edit conflict is safe
- **WHEN** a mutating file tool receives an expected version that no longer matches
- **THEN** it returns a conflict error and does not modify the file

