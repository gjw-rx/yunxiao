## MODIFIED Requirements

### Requirement: Diff preview before apply
`code.edit` SHALL compute a unified diff for its approval summary and SHALL require user approval through the approval gateway before writing. It SHALL NOT automatically open the VS Code diff editor or create editor-preview temporary files. The approval prompt SHALL indicate the file path and that a code edit is being applied.

#### Scenario: Approved edit without editor interruption
- **WHEN** `code.edit` computes a proposed content change
- **THEN** no VS Code diff editor opens, an approval prompt is shown, and approval writes the file

#### Scenario: Denied edit remains unchanged
- **WHEN** the user denies the approval prompt for a `code.edit`
- **THEN** the file is not written and the tool returns `status: 'cancelled'`
