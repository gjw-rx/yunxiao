## Why

Run admission is durable, but tool-result retries, cross-instance continuation, and process restarts can still duplicate work or leave runs stranded. The run harness needs durable receipts and ownership so retries and recovery have one consistent outcome.

## What Changes

- Persist a client-request admission receipt so retries return the original run and never schedule duplicate initial computation.
- Persist a content hash for each tool result and reject a reused tool-call identifier whose payload differs from the accepted result.
- Introduce expiring run-continuation leases to serialize background compute and recovery across application instances.
- Run a bounded startup recovery worker that claims eligible pending or running runs and continues only safely recoverable work.

## Capabilities

### New Capabilities

- `run-idempotency-and-recovery`: Durable run admission, tool-result receipts, leased continuation, and startup recovery behavior.

### Modified Capabilities

- `agent-invoke-orchestration`: Tool-result submission and run continuation now use durable idempotency and recovery semantics.

## Impact

Affected areas include `app/api/agent/run/`, invocation admission and tool-result handling, application startup state, database metadata migrations, and focused run API/service tests. No client API removal is planned.
