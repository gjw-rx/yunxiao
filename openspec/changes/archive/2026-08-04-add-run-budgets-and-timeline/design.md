## Context

The cloud Run protocol already provides a stable `run_id`, ordered persisted events, and exclusive-cursor replay. The VS Code extension stores a bounded snapshot, but it treats retained events as opaque data and the Webview only receives transient EventBus updates. The updated planning documents require the cloud to own budgets and lifecycle truth while the extension restores a readable timeline without guessing.

## Goals / Non-Goals

**Goals:**

- Define structured, replayable budget and batched-content protocol events.
- Retain a bounded, derived timeline and latest budget snapshot with each workspace Run snapshot.
- Deliver restored Run events to the existing UI event path, preserving event order and cursor guarantees.
- Present budget exhaustion as a visible timeline item.

**Non-Goals:**

- Implement cloud budget enforcement, database batching, token metering, or Run lifecycle transitions in this plugin repository.
- Reconstruct missing events, estimate token use, or infer a terminal state from stream closure.
- Add Webview virtualization, accessibility redesign, or a new server API.

## Decisions

### Treat budget and timeline data as persisted protocol facts

`budget_update` and `budget_exhausted` are carried as ordinary ordered Run events. RunStore derives its snapshot only after accepting the event's next contiguous sequence. This keeps reconnect behavior identical to existing replay and prevents client-side accounting drift.

The alternative—separate local counters and timers—would be cheaper to wire but would diverge after reload, retries, and multiple subscribers.

### Keep the RunStore bounded and backward-compatible

The existing retained event window remains the single storage bound. A compact `timeline` projection is retained alongside it, coalescing adjacent content-batch entries and limiting its length to the same configured capacity. Legacy snapshots without the new fields normalize to empty arrays and no budget.

The alternative—persisting all events indefinitely—would make workspace state unbounded.

### Make the Webview consume RunStore-derived timeline events through SessionManager

SessionManager continues to be the protocol adapter. When a persisted Run event is accepted, it emits an EventBus event only if the type is understood; budget events are added to that explicit allowlist. The ChatPanel renders structured timeline and budget messages and never advances a cursor or derives state.

The alternative—letting the Webview maintain its own event/cache state—would create a second recovery implementation and violate the RunStore ownership boundary.

### Specify batching at the producer boundary

Cloud producers coalesce adjacent content deltas for at most 250 ms or 4 KiB before persisting one `content_batch` event. The exact flush can occur earlier at a tool call, lifecycle transition, or stream completion. The extension accepts `content_batch` as immutable output; it does not merge persisted sequence records.

## Risks / Trade-offs

- [Older cloud deployments do not emit budget events] → The UI shows no budget state and remains compatible with ordinary Run events.
- [Timeline retains output text in workspace state] → Apply the existing bounded window and retain only event payloads already accepted for replay.
- [Content batching changes UI update cadence] → Use a short maximum interval and flush at semantic boundaries so tool calls never appear before preceding output.
- [Unknown event types arrive from future servers] → Persist them for cursor continuity but do not dispatch them to the UI until explicitly supported.

## Migration Plan

1. Deploy cloud producers that write the new events to the existing Run event log.
2. Deploy the extension normalization and rendering updates; existing snapshots load with empty timeline/budget state.
3. Roll back by disabling new producer events; the extension continues consuming prior protocol events without state migration.

## Open Questions

- Cloud-side default limits and model-specific token accounting belong to the server configuration and are not defined by this plugin change.
