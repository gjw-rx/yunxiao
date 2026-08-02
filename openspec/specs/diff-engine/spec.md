# diff-engine Specification

## Purpose
TBD
## Requirements
### Requirement: Unified diff parsing
The system SHALL parse a unified diff string into a structured representation of hunks (file header, hunk ranges, context lines, additions, deletions). Malformed input SHALL produce a clear error rather than a silent partial parse.

#### Scenario: Parse a valid unified diff
- **WHEN** `parsePatch` is given a standard unified diff with one hunk
- **THEN** it returns a structured patch object containing the file path and the hunk's line ranges and changes

#### Scenario: Reject malformed diff
- **WHEN** `parsePatch` is given a string that is not a valid unified diff
- **THEN** it returns an error indicating the diff could not be parsed

### Requirement: Patch application with context matching
The system SHALL apply a parsed patch to source content, matching hunks by their context lines. Application SHALL tolerate minor whitespace differences via a bounded fuzz factor. When a hunk's context cannot be matched, application SHALL fail and report a conflict rather than corrupting the file.

#### Scenario: Apply a matching patch
- **WHEN** a patch whose context lines match the source is applied
- **THEN** the result contains the additions and removes the deletions as specified by the hunks

#### Scenario: Reject patch with drifted context
- **WHEN** a patch whose context lines no longer match the source is applied
- **THEN** application fails and returns a conflict error, leaving the source unchanged

### Requirement: Conflict detection
The system SHALL detect when a patch cannot be cleanly applied (context drift, hunk offset beyond fuzz tolerance, overlapping hunks) and surface a structured conflict result rather than writing a partially-applied file. Conflict detection SHALL run before any file is written.

#### Scenario: Concurrent modification detected
- **WHEN** `code.edit` applies a patch whose context was valid at read time but the file changed before apply
- **THEN** the engine returns a conflict error and no write occurs

### Requirement: Diff generation
The system SHALL generate a unified diff between an original and a modified string (file-level), for use in previews and result metadata. The generated diff SHALL be a valid unified diff consumable by `parsePatch`.

#### Scenario: Generate diff between two strings
- **WHEN** `createDiff(original, modified)` is called
- **THEN** it returns a unified diff string describing the added and removed lines
