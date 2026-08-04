## 1. Lock the contract with RED tests

- [x] 1.1 Add metadata tests for the AgentRun cursor, AgentRunEvent fields, logical association, indexes, and `(run_id, sequence)` uniqueness.
- [x] 1.2 Add repository/service tests proving `SELECT FOR UPDATE` allocation, first and sequential sequences, independent Runs, ordered cursor reads, missing Run handling, and invalid limits.
- [x] 1.3 Add transaction tests proving append success commits event and cursor together while insertion failure rolls both back without consuming a sequence.

## 2. Add Run event persistence

- [x] 2.1 Extend AgentRun with a typed non-null `next_event_sequence` cursor defaulting to 1.
- [x] 2.2 Add the typed AgentRunEvent SQLAlchemy model with JSON payload, logical `run_id`, sequence uniqueness, and cursor-read index.
- [x] 2.3 Register AgentRunEvent in shared metadata and add an idempotent startup compatibility migration for the AgentRun cursor.

## 3. Implement atomic sequencing

- [x] 3.1 Implement a transaction-neutral RunEventRepository with Run row locking, event flush, and ordered `after_sequence` reads.
- [x] 3.2 Implement RunEventService append as one caller-visible transaction that locks the Run, allocates the cursor, inserts the event, advances the cursor, and propagates failures after rollback.
- [x] 3.3 Implement validated cursor reads and preserve isolation between Runs.

## 4. Verify scope and quality

- [x] 4.1 Run the Run event and existing AgentRun targeted test suites, including PostgreSQL concurrency coverage when the configured dependency/backend is available.
- [x] 4.2 Run Ruff on changed Python files and OpenSpec validation for `add-run-event-sequencer`.
- [x] 4.3 Review the diff to confirm no SSE/API integration, graph-state duplication, plugin changes, lease/recovery worker, tool receipt, or `max(sequence) + 1` allocation was introduced.
- [x] 4.4 Record changed files, exact verification commands, environment-limited checks, and the next P1 change prerequisite in the cross-session execution memory.
