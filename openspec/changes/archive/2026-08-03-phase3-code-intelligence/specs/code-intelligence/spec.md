## ADDED Requirements

### Requirement: code.get_diagnostics tool
The system SHALL implement `code.get_diagnostics` (permission `read`, site `local`) that queries VSCode Language API for lint/type diagnostics. It SHALL accept an optional `file` parameter (workspace-relative path) to filter by file; when omitted, it SHALL return diagnostics for the entire workspace. It SHALL resolve `file` through the path guard before converting to a `vscode.Uri`. The returned result SHALL be a JSON string containing an array of diagnostics, each with `file`, `line`, `column`, `endLine`, `endColumn`, `severity` (`error`|`warning`|`info`|`hint`), `message`, and `source`. When the total diagnostic count exceeds 50, the tool SHALL truncate: return all errors, up to 20 warnings, and omit info/hint, annotating `{ truncated: true, total: N }`.

#### Scenario: Get diagnostics for a specific file
- **WHEN** `code.get_diagnostics` is called with `{ file: 'src/extension.ts' }` and the file has 2 errors and 1 warning
- **THEN** the tool returns `status: 'success'` with a JSON result containing 3 diagnostics with their severity, message, and location

#### Scenario: Get all workspace diagnostics
- **WHEN** `code.get_diagnostics` is called without a `file` parameter
- **THEN** the tool returns `status: 'success'` with diagnostics from all files in the workspace

#### Scenario: Diagnostics truncation
- **WHEN** `code.get_diagnostics` is called and the workspace has 60 diagnostics (10 errors, 30 warnings, 20 info)
- **THEN** the tool returns 10 errors and 20 warnings with `{ truncated: true, total: 60 }` in the result

#### Scenario: File not found
- **WHEN** `code.get_diagnostics` is called with a file path that does not exist
- **THEN** the tool returns `status: 'error'` with a clear file-not-found message

#### Scenario: Path rejected by guard
- **WHEN** `code.get_diagnostics` is called with a traversal path like `../../../etc/passwd`
- **THEN** the path guard rejects it and the tool returns `status: 'error'` with the guard's reason

#### Scenario: No language service installed
- **WHEN** `code.get_diagnostics` is called for a file type with no language extension installed
- **THEN** the tool returns `status: 'success'` with an empty diagnostics array

### Requirement: code.workspace_symbols tool
The system SHALL implement `code.workspace_symbols` (permission `read`, site `local`) that searches workspace symbols by name via `vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)`. It SHALL accept a `query` parameter (non-empty string) and return a JSON string containing an array of symbols, each with `name`, `kind` (symbol type string), `file`, `line`, and `column`. When the result exceeds 100 symbols, the tool SHALL truncate and annotate `{ truncated: true, total: N }`.

#### Scenario: Search for a function by name
- **WHEN** `code.workspace_symbols` is called with `{ query: 'activate' }` and a function `activate` exists in the workspace
- **THEN** the tool returns `status: 'success'` with a JSON result containing the symbol entry with its file and location

#### Scenario: No matching symbols
- **WHEN** `code.workspace_symbols` is called with `{ query: 'nonexistentFunction12345' }`
- **THEN** the tool returns `status: 'success'` with an empty symbols array

#### Scenario: Symbol results truncation
- **WHEN** `code.workspace_symbols` is called with a broad query matching 150 symbols
- **THEN** the tool returns 100 symbols with `{ truncated: true, total: 150 }` in the result

#### Scenario: Empty query rejected
- **WHEN** `code.workspace_symbols` is called with an empty `query` string
- **THEN** `validate` throws `ToolValidationError` before execution

### Requirement: code.find_references tool
The system SHALL implement `code.find_references` (permission `read`, site `local`) that finds all references to a symbol at a given position via `vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position)`. It SHALL accept `file` (workspace-relative path), `line` (1-based integer), and `column` (1-based integer) parameters. It SHALL resolve `file` through the path guard. The returned result SHALL be a JSON string containing an array of references grouped by file, each with `file`, `line`, and `column`. When the total reference count exceeds 50, the tool SHALL truncate: return up to 10 references per file, annotate `{ truncated: true, total: N }`.

#### Scenario: Find references to a function
- **WHEN** `code.find_references` is called with `{ file: 'src/extension.ts', line: 25, column: 10 }` and the function at that position is referenced in 3 files
- **THEN** the tool returns `status: 'success'` with a JSON result containing all reference locations grouped by file

#### Scenario: No references found
- **WHEN** `code.find_references` is called at a position with no references
- **THEN** the tool returns `status: 'success'` with an empty references array

#### Scenario: References truncation
- **WHEN** `code.find_references` is called and finds 80 references across 5 files
- **THEN** the tool returns up to 10 references per file (50 total) with `{ truncated: true, total: 80 }` in the result

#### Scenario: Path rejected by guard
- **WHEN** `code.find_references` is called with a traversal path
- **THEN** the path guard rejects it and the tool returns `status: 'error'` with the guard's reason

### Requirement: code.go_to_definition tool
The system SHALL implement `code.go_to_definition` (permission `read`, site `local`) that finds the definition of a symbol at a given position via `vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position)`. It SHALL accept `file` (workspace-relative path), `line` (1-based integer), and `column` (1-based integer) parameters. It SHALL resolve `file` through the path guard. The returned result SHALL be a JSON string containing an array of definition locations, each with `file`, `line`, and `column`.

#### Scenario: Go to definition of a function call
- **WHEN** `code.go_to_definition` is called with `{ file: 'src/extension.ts', line: 30, column: 5 }` at a function call position
- **THEN** the tool returns `status: 'success'` with a JSON result containing the definition location

#### Scenario: No definition found
- **WHEN** `code.go_to_definition` is called at a position with no resolvable definition
- **THEN** the tool returns `status: 'success'` with an empty definitions array

#### Scenario: Path rejected by guard
- **WHEN** `code.go_to_definition` is called with a traversal path
- **THEN** the path guard rejects it and the tool returns `status: 'error'` with the guard's reason

### Requirement: Position parameter convention for code intelligence tools
All code intelligence tools that accept a position (`code.find_references`, `code.go_to_definition`) SHALL use 1-based `line` and `column` integers, and `file` as a workspace-relative path. The tool SHALL convert these internally to `vscode.Uri` (via path guard resolution) and `vscode.Position` (0-based internally). This convention SHALL be documented in the tool's parameter schema description so the LLM generates correct coordinates.

#### Scenario: 1-based line converted to 0-based internally
- **WHEN** `code.find_references` is called with `{ file: 'src/extension.ts', line: 1, column: 1 }`
- **THEN** the tool internally creates `new vscode.Position(0, 0)` for the VSCode API call

#### Scenario: Invalid line or column
- **WHEN** `code.find_references` is called with `{ file: 'src/extension.ts', line: 0, column: 1 }`
- **THEN** `validate` throws `ToolValidationError` because line must be >= 1

### Requirement: All code intelligence tools are read-only
All `code.*` intelligence tools (`code.get_diagnostics`, `code.workspace_symbols`, `code.find_references`, `code.go_to_definition`) SHALL declare permission `read` and site `local`. They SHALL NOT mutate the filesystem or editor state. They SHALL execute without user approval (read permission bypasses the approval gateway).

#### Scenario: No approval required for diagnostics
- **WHEN** the agent calls `code.get_diagnostics`
- **THEN** the tool executes immediately without an approval prompt

#### Scenario: No approval required for find_references
- **WHEN** the agent calls `code.find_references`
- **THEN** the tool executes immediately without an approval prompt
