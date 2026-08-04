## Why

Run events can be replayed safely, but the extension does not retain Run-level budget state or render a recovered timeline from that durable event stream. Long or stalled Runs therefore lack a reliable, user-visible explanation of consumed limits and terminal budget decisions.

## What Changes

- Add a Run-budget protocol that records cumulative step, wall-clock, token, output-size, and repeated-call usage, and emits a structured budget-exhausted event before stopping a Run.
- Batch adjacent content deltas before they are persisted or rendered, with a bounded time/size window that preserves ordered replay.
- Extend the workspace RunStore with compact timeline records and budget state derived only from persisted Run events.
- Render the Webview Run timeline and budget status from RunStore-backed events, including after extension-host restoration.

## Capabilities

### New Capabilities

- `run-budgets-and-timeline`: Run-level budget accounting, bounded delta batching, and replayable timeline presentation.

### Modified Capabilities

- `plugin-run-store-replay`: Store the compact timeline and budget snapshot alongside the existing Run cursor without weakening contiguous replay rules.

## Impact

- Plugin code: `src/core/runStore.ts`, `src/core/sessionManager.ts`, and `src/chatPanel.ts`.
- Plugin tests: RunStore, SessionManager, and Webview event handling coverage.
- Cloud Run producers must emit the specified persisted budget and batched content events; the extension remains a consumer and does not infer authoritative lifecycle or budget state.
