# large-file-read Specification

## Purpose
定义大文件/大目录的分页读取能力:行号输出、offset/limit 分页、行数+字节双预算、单行截断、超限续读提示,使大文件不再被整体拒绝或不可定位截断。

## Requirements

### Requirement: fs.read_file 分页读取
The system SHALL support paged reads of UTF-8 text files via `fs.read_file` with `offset` (1-indexed starting line, default 1) and `limit` (maximum lines to return, default 2000) parameters. Output SHALL prefix each line with its 1-based line number as `<line>: <content>`. A file larger than the configured maximum size (default 1 MB) SHALL NOT be rejected outright; instead the tool SHALL read within a budget bounded by both the line limit and a byte hard cap (default 50 KB), stop as soon as either budget is exhausted, and return a continuation hint `Use offset=<next> to continue` so the model can page through the file.

#### Scenario: 小文件整体返回
- **WHEN** the agent calls `fs.read_file` with `path` on a file within both line and byte budgets
- **THEN** the tool returns `status: 'success'` with line-numbered content and an end-of-file marker (`(End of file - total N lines)`)

#### Scenario: 大文件分页续读
- **WHEN** the agent calls `fs.read_file` with `path`, `offset: 2001`, `limit: 2000` on a file with 5000 lines
- **THEN** the tool returns lines 2001–4000 with line numbers and a hint `Use offset=4001 to continue`

#### Scenario: 超限文件不再整体拒绝
- **WHEN** `fs.read_file` is called on a file larger than the configured maximum (default 1 MB)
- **THEN** the tool returns the first page of content (not an error) with a continuation hint

#### Scenario: 字节预算截断
- **WHEN** the accumulated bytes of the returned lines exceed the byte hard cap (default 50 KB)
- **THEN** the tool stops reading, returns the lines already collected with a truncation marker, and includes a continuation hint

#### Scenario: 单行截断
- **WHEN** a single line exceeds the line length cap (default 2000 characters)
- **THEN** that line is returned truncated to the cap with a `... (line truncated ...)` marker, and subsequent lines are unaffected

#### Scenario: offset 越界
- **WHEN** `fs.read_file` is called with an `offset` beyond the file's line count
- **THEN** the tool returns `status: 'error'` with a clear out-of-range message (offset vs total lines)

### Requirement: fs.list_dir 分页
The system SHALL support pagination for `fs.list_dir` via `offset` (default 1) and `limit` (default 2000) parameters. When the directory contains more entries than the requested limit, the tool SHALL return the first page and a hint (`Use offset=<next> to continue`) indicating remaining entries.

#### Scenario: 目录超限提示续读
- **WHEN** `fs.list_dir` is called on a directory with more entries than `limit`
- **THEN** the tool returns `limit` entries and a hint showing how many remain and how to continue

#### Scenario: 目录整体返回
- **WHEN** `fs.list_dir` is called on a directory with entries within the limit
- **THEN** the tool returns all entries and the entry count without a continuation hint
