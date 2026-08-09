# file-tools Delta Specification

## Purpose
修改 `fs.read_file` 与 `fs.list_dir` 需求:大文件/大目录由"超限拒绝"改为"分页可读",输出带行号,受行数+字节双预算约束,并提供续读提示。

## MODIFIED Requirements

### Requirement: fs.read_file tool
The system SHALL implement `fs.read_file` that reads a UTF-8 text file located via the path guard. It SHALL resolve the path through the path guard (workspace root + traversal/symlink/sensitive checks), detect binary files and refuse to return them as text, and support paged reads: `offset` (1-indexed starting line, default 1) and `limit` (maximum lines to return, default 2000). Output SHALL prefix each line with its 1-based line number (`<line>: <content>`). Reading SHALL be bounded by both the line limit and a byte hard cap (default 50 KB); when either budget is exhausted the tool SHALL stop, return the lines already collected with a truncation marker, and include a continuation hint `Use offset=<next> to continue`. A file larger than the configured maximum size (default 1 MB, configurable) SHALL NOT be rejected outright; it SHALL be returned page by page instead. Single lines longer than the line length cap (default 2000 characters) SHALL be truncated with a marker.

#### Scenario: Read a small text file
- **WHEN** the agent calls `fs.read_file` with `path: 'src/extension.ts'` and the file exists and is text within the line and byte budgets
- **THEN** the tool returns `status: 'success'` with line-numbered content and an end-of-file marker

#### Scenario: Read a non-existent file
- **WHEN** `fs.read_file` is called with a path that does not exist
- **THEN** the tool returns `status: 'error'` with a clear file-not-found error

#### Scenario: File larger than limit is paged
- **WHEN** `fs.read_file` is called on a file larger than the configured maximum (default 1 MB)
- **THEN** the tool returns the first page of line-numbered content (not an error) with a continuation hint `Use offset=<next> to continue`

#### Scenario: Paged continuation read
- **WHEN** the agent calls `fs.read_file` again with a larger `offset` after a truncated read
- **THEN** the tool returns the next page starting at that line, continuing until the file is exhausted

#### Scenario: Byte-budget truncation
- **WHEN** the accumulated bytes of returned lines exceed the byte hard cap (default 50 KB)
- **THEN** the tool stops reading, returns the collected lines with a truncation marker and a continuation hint

#### Scenario: Single long line truncated
- **WHEN** a line in the file exceeds the line length cap (default 2000 characters)
- **THEN** that line is returned truncated with a `... (line truncated ...)` marker and other lines are unaffected

#### Scenario: Offset out of range
- **WHEN** `fs.read_file` is called with an `offset` beyond the file's line count
- **THEN** the tool returns `status: 'error'` with a clear out-of-range message (offset vs total lines)

#### Scenario: Binary file detection
- **WHEN** `fs.read_file` is called on a binary file (e.g. a PNG)
- **THEN** the tool returns `status: 'error'` (or a placeholder indication) stating the file is binary and is not returned as text

#### Scenario: Path rejected by guard
- **WHEN** `fs.read_file` is called with a traversal path like `../../../etc/passwd`
- **THEN** the path guard rejects it and the tool returns `status: 'error'` with the guard's reason

### Requirement: fs.list_dir tool
The system SHALL implement `fs.list_dir` (permission `read`, site `local`) that lists entries under a directory resolved via the path guard. It SHALL return each entry's name, type (file/directory), size, and modification time. It SHALL respect `.gitignore` rules (preferably via ripgrep `--files`; otherwise a built-in minimal ignore matcher) and SHALL support filtering by entry type. The default listing SHALL be non-recursive (single level); recursion SHALL be opt-in via a parameter. It SHALL support pagination via `offset` (default 1) and `limit` (default 2000); when a directory has more entries than the limit, it SHALL return the first page plus a hint (`Use offset=<next> to continue`) indicating how many entries remain.

#### Scenario: List a directory
- **WHEN** `fs.list_dir` is called with a valid directory path
- **THEN** the tool returns `status: 'success'` with entries containing name, type, size, and mtime

#### Scenario: gitignored entries excluded
- **WHEN** `fs.list_dir` is called on a directory containing `node_modules/` and `node_modules` is gitignored
- **THEN** the returned entries exclude `node_modules`

#### Scenario: Directory pagination
- **WHEN** `fs.list_dir` is called on a directory with more entries than `limit`
- **THEN** the tool returns `limit` entries plus a hint showing the remaining count and how to continue
