## Context

The existing run API persists `AgentRun` identity and ordered events, while initial and resumed computation is scheduled in the current process. Duplicate tool-result detection is process-local. A restart or another application instance therefore cannot reliably distinguish accepted work from work that must be resumed.

## Goals / Non-Goals

**Goals:**

- Make request admission and tool-result acceptance durable and deterministic.
- Ensure at most one process owns continuation of a run at a time.
- Resume safely recoverable work after application startup without coupling it to an SSE connection.

**Non-Goals:**

- Replacing LangGraph checkpoints or persisting graph-step snapshots.
- Providing exactly-once guarantees for side effects that occurred before a client delivered its tool result.
- Adding Redis, a queue, plugin RunStore, or cross-session scheduling.

## Decisions

1. Store receipts on `AgentRun` instead of adding a broad execution journal. A unique `(run_id, tool_call_id)` receipt stores a SHA-256 hash of the canonical submitted result batch. The same hash is acknowledged; a different hash is rejected. This gives durable retry semantics with the minimum extra data.
2. Use a lease token and expiry columns on `AgentRun`, claimed with a conditional database update. This works with the existing PostgreSQL/SQLite SQLAlchemy deployment and avoids adding Redis or an advisory-lock lifecycle.
3. Compute obtains a lease before scheduling and releases it on terminal completion. Lease expiry permits another instance or startup recovery to take over after a crash. The owner renews immediately before durable state changes; long-running graph calls are bounded by lease duration and are not duplicated while a valid lease exists.
4. Startup recovery scans a bounded number of pending/running runs, claims each lease, and resumes only runs with a checkpoint and a durable tool-result receipt. Pending initial runs are retried from their persisted admission input; running runs without a safe continuation point are marked failed rather than guessing.

## Risks / Trade-offs

- [A process pauses beyond the lease] → A second owner can take over; lease duration is conservative and every event/status update validates ownership.
- [A tool executed but no receipt reached the server] → The system cannot prove the outcome; recovery leaves the run interrupted/failed instead of replaying the local side effect.
- [Schema migration on existing databases] → Additive nullable/defaulted columns and tables are created during the existing compatibility migration, with no destructive migration.

## Migration Plan

1. Add receipt and lease schema metadata, then create missing columns/tables through the existing startup migration path.
2. Route admission and tool-result continuation through the durable receipt/lease service.
3. Start recovery after database and agent assembly initialization; stop tracked tasks before database disposal.
4. Roll back by deploying the previous version; additive data is ignored by the prior schema.

## Open Questions

- None for this scoped change. A queue-backed multi-region ownership mechanism remains a later change.
