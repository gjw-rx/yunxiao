## ADDED Requirements

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
Every `fs.*` tool introduced in Phase 2 SHALL resolve its target path(s) through the path guard before any filesystem operation, identical to `fs.read_file`. Path-guard rejection (traversal, symlink escape, no workspace) SHALL return `status: 'error'` with the guard's reason and SHALL NOT touch the filesystem.

#### Scenario: Out-of-workspace path rejected
- **WHEN** any new `fs.*` tool is called with a path outside the workspace roots
- **THEN** the path guard rejects it and the tool returns `status: 'error'` without filesystem access
