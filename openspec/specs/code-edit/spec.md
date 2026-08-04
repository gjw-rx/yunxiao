# code-edit Specification

## Purpose
Provide safe, reviewable workspace edits with path protection, diff approval, and concurrency checks.
## Requirements
### Requirement: code.edit exact-string replacement mode
The system SHALL implement `code.edit` supporting an exact-string replacement mode invoked with `{ path, oldString, newString }`. Before applying, it SHALL re-read the target file and verify that `oldString` occurs exactly once; zero occurrences SHALL error as "not found" and more than one SHALL error as "ambiguous match, provide more context". On success it SHALL replace the single occurrence and write the result.

#### Scenario: Replace a unique string
- **WHEN** `code.edit` is called with an `oldString` that occurs exactly once in the file
- **THEN** the occurrence is replaced with `newString` and the tool returns `status: 'success'`

#### Scenario: Ambiguous match rejected
- **WHEN** `code.edit` is called with an `oldString` that occurs more than once
- **THEN** the tool returns `status: 'error'` indicating the match is ambiguous and no change is made

#### Scenario: String not found
- **WHEN** `code.edit` is called with an `oldString` not present in the file
- **THEN** the tool returns `status: 'error'` indicating the string was not found and no change is made

### Requirement: code.edit unified-diff patch mode
The system SHALL support a patch mode invoked with `{ path, patch }` where `patch` is a unified diff. It SHALL apply the patch via the diff engine with context matching and conflict detection; on conflict it SHALL return `status: 'error'` without writing.

#### Scenario: Apply a clean patch
- **WHEN** `code.edit` is called with a patch whose context matches the file
- **THEN** the patch is applied and the tool returns `status: 'success'`

#### Scenario: Conflicting patch rejected
- **WHEN** `code.edit` is called with a patch whose context has drifted
- **THEN** the tool returns `status: 'error'` with a conflict reason and the file is unchanged

### Requirement: Re-read before apply to prevent concurrent-overwrite
`code.edit` SHALL capture a preview baseline from the exact content used to create the proposed edit and diff. If `expectedVersion` is supplied, it SHALL match this baseline before approval. After approval, immediately before apply, the tool SHALL re-read or re-version the target and compare it with the baseline. If the final check detects drift or deletion, it SHALL return a non-retryable conflict, remove the preview, preserve the target, and not apply stale content. This does not provide filesystem compare-and-swap across the final check and replace.

#### Scenario: File changed since agent read
- **WHEN** the file version differs from the supplied `expectedVersion` before the preview is generated
- **THEN** the tool returns `status: 'error'` with a conflict reason and does not request approval or write the file

#### Scenario: File changes while approval is pending
- **WHEN** the user or another process modifies the target after the diff preview is generated but before approval completes
- **THEN** the post-approval version check returns `status: 'error'`, marks the conflict non-retryable, removes the temporary preview, and preserves the newer target content

#### Scenario: Approved preview remains current
- **WHEN** the user approves the edit and the target version still equals the preview baseline
- **THEN** `code.edit` applies the approved proposed content and returns success metadata containing `base_version` and `applied_version`

### Requirement: Diff preview before apply
`code.edit` SHALL present a diff preview (original vs proposed content via the VSCode diff editor) and require user approval through the approval gateway before writing. The approval prompt SHALL indicate the file path and that a code edit is being applied.

#### Scenario: Preview shown then approved
- **WHEN** `code.edit` computes the proposed content
- **THEN** a diff editor opens showing original vs proposed, and an approval prompt is shown; on approval the file is written

#### Scenario: Preview shown then denied
- **WHEN** the user denies the approval prompt for a `code.edit`
- **THEN** the file is not written and the tool returns `status: 'cancelled'`

### Requirement: code.edit result metadata
On success, `code.edit` SHALL return metadata containing the `diff` (unified diff of the change) and `affected_files` (array containing the edited path), so the cloud can record/surface the change.

#### Scenario: Success metadata includes diff
- **WHEN** `code.edit` applies successfully
- **THEN** the result `metadata` contains a `diff` string and `affected_files: [<path>]`

### Requirement: code.edit path safety
`code.edit` SHALL resolve the target path through the path guard (workspace root, traversal/symlink/sensitive checks) before any read or write. Path-guard rejection SHALL return `status: 'error'` with the guard's reason and no file access.

#### Scenario: Traversal path rejected
- **WHEN** `code.edit` is called with `path: '../../../etc/passwd'`
- **THEN** the path guard rejects it and the tool returns `status: 'error'` without reading or writing
