## MODIFIED Requirements

### Requirement: Optimistic version checking across preview and apply
`code.edit` SHALL capture a deterministic version from the exact content used to construct its diff preview. If `expectedVersion` is supplied, it SHALL match that preview version. After approval and immediately before applying the preview, the tool SHALL re-read the target and reject the edit without writing if its version differs from the preview version. A successful result SHALL include both the preview base version and the applied content version.

#### Scenario: Expected version differs before preview
- **WHEN** the file version differs from the supplied `expectedVersion` before preview generation
- **THEN** the tool returns `status: 'error'` with a non-retryable conflict result and does not prompt or modify the file

#### Scenario: File changes while approval is pending
- **WHEN** the user or another process modifies the target after the diff preview is created but before approval completes
- **THEN** the post-approval version check returns `status: 'error'`, does not overwrite the file, and cleans up the preview

#### Scenario: Successful edit returns version chain
- **WHEN** the user approves an edit and the target remains at the preview base version
- **THEN** the tool applies the preview and returns the base and applied version tokens in result metadata
