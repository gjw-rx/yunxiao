## Context

The `add-session-todo-write` change deliberately injects a freshly formatted active-task system message before every AgentLoop request. That message is stored separately from chat history so task state survives compaction, but it also sits before every historical user, assistant, and tool message. A `todo_write` status update therefore changes an early request prefix even though the updated tool result is already present at the end of normal history.

The extension delegates prompt caching to the configured OpenAI-compatible provider. It records provider-reported cache usage but does not control or clear a local cache. The design must consequently preserve a stable request prefix while retaining the existing guarantees that active tasks survive compaction, restart, and session reopening.

## Goals / Non-Goals

**Goals:**

- Avoid a mutable todo system message before history during normal AgentLoop tool follow-ups.
- Keep the latest todo state model-visible after a normal `todo_write`, compaction, restart, and historical-session reopening.
- Keep tool-call/result pairing valid and retain the current no-synthetic-transcript behavior.
- Make recovery injection observable and cover request ordering with deterministic tests.

**Non-Goals:**

- Change the `todo_write` schema, task persistence format, task-panel behavior, or provider cache policy.
- Guarantee a particular cache-hit count, which remains provider- and model-dependent.
- Reorder regular system messages behind user or tool messages solely for caching.

## Decisions

### D1: Use the successful `todo_write` tool result as the normal-turn task source

After a successful `todo_write`, the AgentLoop already persists the assistant tool call and its structured tool result in effective history before issuing the next request. The request assembler SHALL treat a matching latest todo tool result as sufficient task context and SHALL not add a second active-task system message.

This removes the redundant mutable prefix while allowing the model to see the exact full snapshot it just wrote. It is preferable to moving the mutable task system message to the end of the message list: trailing system messages are not uniformly supported by OpenAI-compatible providers and can weaken system-instruction semantics.

### D2: Store an immutable active-task context with each compaction checkpoint

When a checkpoint is successfully written, the compaction path SHALL capture the current active-task context and persist it as explicit checkpoint data. Effective-history reconstruction SHALL emit that checkpoint task context adjacent to the checkpoint summary. It remains unchanged until a later compaction replaces the checkpoint; later `todo_write` tool results in the retained tail remain the newer source of truth.

This keeps the post-compaction request prefix stable across ordinary work and task completions. It is preferable to asking the summarization model to remember tasks because summaries are probabilistic and could omit or alter task state. The checkpoint context is extension-owned, compact, and deterministic.

### D3: Retain a narrow recovery fallback for legacy or incomplete effective histories

Before a request, AgentLoop SHALL compare the durable current task snapshot with model-visible task evidence: a matching successful `todo_write` result in effective history or the current checkpoint task context. If neither is present and active work exists, it SHALL inject the existing transient active-task system context and log the recovery reason.

This covers sessions created before checkpoint task contexts existed, malformed/legacy checkpoints, and any exceptional history loss without weakening normal caching. A recovery context may repeat for subsequent requests until the task is represented in history, but its content remains stable; it is no longer changed for every normal task completion.

### D4: Test request prefixes and recovery behavior, not provider cache counters

Tests SHALL capture LLM requests and assert message order/content for consecutive todo updates, post-compaction reconstruction, and recovery. They SHALL not assert cache-read numbers because those values are provider-specific runtime telemetry. Runtime logs SHALL include the session ID, decision (`tool_result`, `checkpoint`, `recovery`, or `none`), active task count, and recovery reason where applicable.

## Risks / Trade-offs

- [Legacy compacted session has active todo state but no matching history evidence] → Use the recovery fallback and write the checkpoint context at the next successful compaction.
- [Checkpoint task context becomes stale after a later `todo_write`] → The later retained `todo_write` result is the authoritative newest state; a checkpoint is only fallback context for the state at compaction time.
- [Additional checkpoint metadata adds persisted data] → Make it optional and treat missing or malformed data as absent so existing JSONL records remain readable.
- [Provider cache behavior differs by model/provider] → Verify only stable request construction and use provider-reported cache telemetry for operational validation.

## Migration Plan

1. Read existing compaction records without checkpoint task context as valid legacy records.
2. New checkpoints write optional deterministic task context when active tasks exist.
3. Existing sessions use recovery injection only when their effective history lacks matching todo evidence.
4. Roll back by ignoring the optional checkpoint field and restoring per-request injection; persisted session and transcript data remain compatible.

## Open Questions

None. The current provider abstraction does not expose a portable prompt-cache control API, so request-prefix stability is the appropriate boundary for this change.
