## ADDED Requirements

### Requirement: Workspace root resolution
The path guard SHALL resolve one or more workspace roots from `vscode.workspace.workspaceFolders`. All file-tool paths SHALL be resolved and constrained relative to these roots. When no workspace folder is open, the path guard SHALL reject every file operation with a clear error rather than falling back to an arbitrary directory.

#### Scenario: Single workspace folder open
- **WHEN** exactly one workspace folder is open and a tool requests path `src/extension.ts`
- **THEN** the guard resolves it to `<workspaceRoot>/src/extension.ts` and accepts it

#### Scenario: No workspace folder open
- **WHEN** no workspace folder is open and any file tool is invoked
- **THEN** the guard rejects the operation with an error message indicating no workspace is open

#### Scenario: Multi-root workspace
- **WHEN** multiple workspace folders are open and a tool requests an absolute path inside any one of them
- **THEN** the guard accepts the path; a path inside none of the roots is rejected

### Requirement: Path traversal protection
The path guard SHALL normalize the requested path (resolving `.` and `..` segments) and MUST reject any path whose canonical form escapes all workspace roots. This applies to both relative and absolute inputs.

#### Scenario: Relative traversal escape
- **WHEN** a tool requests `../../../etc/passwd`
- **THEN** the guard rejects the path with a traversal-detected error and returns no file content

#### Scenario: Absolute path outside workspace
- **WHEN** a tool requests an absolute path `/etc/passwd` (or `C:\Windows\System32\...` on Windows) that is outside all workspace roots
- **THEN** the guard rejects the path

#### Scenario: Traversal that stays inside workspace
- **WHEN** a tool requests `src/../src/extension.ts`
- **THEN** the guard normalizes it to `src/extension.ts` and accepts it

### Requirement: Cross-platform path canonicalization
The path guard SHALL accept both POSIX (`/`) and Windows (`\`, drive letters) path separators and produce a canonical normalized path before the containment check, so the same logical path is accepted regardless of host OS.

#### Scenario: Mixed separators on Windows
- **WHEN** running on Windows and a tool requests `src\..\src\extension.ts`
- **THEN** the guard normalizes and accepts the path

#### Scenario: Drive-letter absolute path inside workspace
- **WHEN** running on Windows and a tool requests `D:\workspace\src\extension.ts` where `D:\workspace` is a workspace root
- **THEN** the guard accepts the path

### Requirement: Symbolic link handling
The path guard SHALL resolve symbolic links (realpath) before the containment check so that a symlink pointing outside the workspace is detected and rejected. A configuration flag SHALL allow opting out of symlink following for read-only tools, but the default MUST follow links and verify the final target is contained.

#### Scenario: Symlink escaping workspace
- **WHEN** a file inside the workspace is a symlink whose target is outside all workspace roots
- **THEN** the guard rejects access to that file by default

#### Scenario: Symlink staying inside workspace
- **WHEN** a file inside the workspace is a symlink whose target is also inside a workspace root
- **THEN** the guard accepts access

### Requirement: Sensitive file detection
The path guard SHALL flag well-known sensitive files and directories (e.g. `.env`, `.git/`, `credentials.json`, private key files) and require them to be treated as needing elevated approval. In Phase 1 (no approval gateway yet), sensitive-file access SHALL be logged and surfaced to the user as a warning, and the tool result SHALL be redacted for secrets rather than returned raw.

#### Scenario: .env file requested
- **WHEN** a tool requests `.env`
- **THEN** the guard flags it as sensitive, emits a user-visible warning, and the returned content has likely-secret values redacted

#### Scenario: .git directory traversal
- **WHEN** a tool requests `.git/config`
- **THEN** the guard flags it as sensitive and surfaces a warning before returning redacted content
