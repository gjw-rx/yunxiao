## MODIFIED Requirements

### Requirement: Re-read before apply to prevent concurrent-overwrite
`code.edit` SHALL capture a file version from the exact content used to create the proposed edit and diff preview. If `expectedVersion` is supplied, it SHALL match this preview baseline before approval is requested. After approval completes and immediately before writing, `code.edit` SHALL re-read or re-version the target and compare it with the preview baseline. If that final check observes that the target changed or disappeared since preview generation, the tool SHALL return a non-retryable conflict, remove its temporary preview, preserve the current target, and SHALL NOT apply the stale proposed content. This requirement does not claim a filesystem compare-and-swap guarantee across the final check and replace operation.

#### Scenario: File changed since agent read
- **WHEN** the file version differs from the supplied `expectedVersion` before the preview is generated
- **THEN** the tool returns `status: 'error'` with a conflict reason and does not request approval or write the file

#### Scenario: File changes while approval is pending
- **WHEN** the user or another process modifies the target after the diff preview is generated but before approval completes
- **THEN** the post-approval version check returns `status: 'error'`, marks the conflict non-retryable, removes the temporary preview, and preserves the newer target content

#### Scenario: Approved preview remains current
- **WHEN** the user approves the edit and the target version still equals the preview baseline
- **THEN** `code.edit` applies the approved proposed content and returns its normal success metadata
