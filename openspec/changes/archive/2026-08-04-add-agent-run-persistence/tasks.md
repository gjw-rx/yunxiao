## 1. Lock the reduced design with RED tests

- [x] 1.1 Add metadata tests proving exactly one new `agent_run` table with the required fields, indexes, uniqueness constraints, and no database foreign keys or cascades.
- [x] 1.2 Add RunService tests for first admission, sequential duplicate admission, concurrent uniqueness conflicts resolving to one Run, scoped client request IDs, controlled status transitions, checkpoint updates, and recovery candidate scans.
- [x] 1.3 Add Trace tests proving nullable `run_id` / `tool_call_id` persistence, tool-call ID extraction, existing-row compatibility, and rejection of Runnable event IDs as application Run identity.
- [x] 1.4 Add orchestration tests proving initial and resume graph calls request `durability="sync"` and production checkpointer failure prevents uncheckpointed execution.

## 2. Add the lightweight AgentRun boundary

- [x] 2.1 Create `app/api/agent/run/` with a typed `AgentRun` SQLAlchemy model containing only `run_id`, `session_id`, `client_request_id`, `status`, `last_checkpoint_id`, and shared timestamps.
- [x] 2.2 Add unique `run_id` and `(session_id, client_request_id)` constraints plus session/status indexes without declaring database foreign keys.
- [x] 2.3 Implement an async RunRepository that flushes and queries without committing or suppressing integrity errors.
- [x] 2.4 Implement a minimal RunService for `create_or_get`, `get`, expected-status transitions, checkpoint recording, and `pending` / `running` recovery scans.
- [x] 2.5 Register only AgentRun in shared metadata/create-all and verify existing invoke rows remain unchanged.

## 3. Correlate existing AgentTrace records

- [x] 3.1 Add nullable indexed `run_id` and nullable `tool_call_id` columns to AgentTrace ORM/schema plus the existing explicit migration helper for stored databases.
- [x] 3.2 Extend TraceEntry, runtime context, assistant tracing, and tool tracing so new Run-aware paths preserve the application `run_id` and tool-call ID.
- [x] 3.3 Keep trace writes best-effort and confirm Run admission, status, checkpoint recovery, and tool-result idempotency never depend on AgentTrace success.

## 4. Make LangGraph persistence authoritative

- [x] 4.1 Pass `durability="sync"` through initial non-streaming, initial streaming, and every `Command(resume=...)` graph execution path.
- [x] 4.2 Separate checkpointer initialization failure from optional Store/embedding degradation so production persistent mode cannot silently continue with `checkpointer=None`.
- [x] 4.3 Add an explicit guard shared by invoke, stream, and resume paths that rejects execution when production persistence is unavailable while preserving explicitly configured development memory mode.
- [x] 4.4 Verify reconnect/state inspection reads compiled graph checkpoints and message history, with no Step/ToolCall/Event reconstruction from AgentRun or Trace.

## 5. Verify compatibility and scope

- [ ] 5.1 Run the AgentRun, Trace, LangGraph backend, invoke, stream, resume, and existing v1 API regression tests.
- [x] 5.2 Run Ruff on changed Python files; no project type-check command is configured.
- [x] 5.3 Review the diff to confirm no `AgentStep`, `AgentToolCall`, `AgentRunEvent`, event sequence allocator, database foreign key, plugin, Webview, background worker, distributed lease, tool execution receipt, or Agent Server migration was added.
- [x] 5.4 Record exact SSE/token replay, compute/subscription decoupling, same-thread distributed ownership, automatic startup advancement, and durable tool-result admission as follow-up changes rather than claiming them complete.
