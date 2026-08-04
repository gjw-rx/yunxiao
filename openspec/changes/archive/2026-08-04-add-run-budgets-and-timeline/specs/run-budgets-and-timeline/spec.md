## ADDED Requirements

### Requirement: Run-level budget accounting
The cloud Run producer SHALL enforce configured step, wall-clock, token, output-size, and repeated-call limits for each admitted Run. It SHALL persist an ordered `budget_update` event whenever authoritative cumulative usage is reported and SHALL persist one structured `budget_exhausted` event before it stops a Run for any exceeded limit.

#### Scenario: Cumulative usage is replayable
- **WHEN** a Run reports new token or output usage within its configured limits
- **THEN** its next committed event contains the cumulative budget usage and limits in a `budget_update` payload

#### Scenario: A budget stops a Run
- **WHEN** a Run reaches any configured budget limit
- **THEN** the cloud persists a `budget_exhausted` payload that identifies the exceeded dimension, current usage, and configured limit before the terminal lifecycle event

### Requirement: Bounded content-delta persistence
The cloud Run producer SHALL coalesce adjacent content deltas into one persisted `content_batch` event for no longer than 250 milliseconds or 4 KiB of UTF-8 content, whichever occurs first. It MUST flush a pending batch before a tool-call, budget, lifecycle, or stream-completion event.

#### Scenario: Small deltas are batched
- **WHEN** adjacent content deltas remain below 4 KiB for less than 250 milliseconds
- **THEN** the cloud persists them as one ordered `content_batch` event

#### Scenario: A semantic boundary flushes content
- **WHEN** a local tool call follows pending content deltas
- **THEN** the cloud commits the pending `content_batch` before the tool-call event

### Requirement: RunStore-backed timeline presentation
The extension SHALL derive a bounded timeline and latest budget snapshot only from contiguously accepted persisted Run events. The Webview SHALL render budget and timeline data from this projection and MUST NOT estimate budget usage or infer Run lifecycle from transport closure.

#### Scenario: Restored budget is displayed
- **WHEN** a non-terminal Run snapshot with an accepted `budget_update` is restored after extension-host recreation
- **THEN** the Webview receives the stored budget state before later replayed events

#### Scenario: Exhausted budget is visible
- **WHEN** a contiguously accepted `budget_exhausted` event is dispatched to the Webview
- **THEN** the timeline presents the specified exceeded budget without creating a local lifecycle transition
