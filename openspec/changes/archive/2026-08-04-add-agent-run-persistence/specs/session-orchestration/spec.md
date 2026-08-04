## ADDED Requirements

### Requirement: LangGraph checkpoint is the graph execution authority
The cloud orchestration layer SHALL use the persistent LangGraph checkpointer as the sole source of graph node state, pending tasks, interrupts, messages, and resume position. Business Run and Trace storage MUST NOT duplicate or override that graph state.

#### Scenario: Resume after an interrupt
- **WHEN** a persisted graph is resumed using `Command(resume=...)`
- **THEN** the orchestration layer uses the same `thread_id` and the checkpoint-selected interrupt state

#### Scenario: Recover current graph state
- **WHEN** the service needs to inspect an interrupted or incomplete Run
- **THEN** it queries the compiled graph state/checkpoint history instead of reconstructing execution from Trace or AgentRun rows

### Requirement: Synchronous checkpoint durability
The cloud orchestration layer MUST invoke initial persistent graph execution and every `Command(resume=...)` continuation with LangGraph durability set to `sync`.

#### Scenario: Initial execution persists before advancing
- **WHEN** a persistent graph starts processing a user input
- **THEN** each completed super-step checkpoint is synchronously persisted before the next super-step begins

#### Scenario: Resume uses the same durability guarantee
- **WHEN** external tool or human input resumes an interrupted graph
- **THEN** the continuation also uses synchronous checkpoint durability

### Requirement: Production checkpointer failure is fail-closed
When production configuration requires PostgreSQL persistence, the service MUST NOT execute Agent graphs if the persistent checkpointer failed to initialize. An explicitly configured development memory backend MAY continue to use an in-memory checkpointer.

#### Scenario: Production checkpointer setup fails
- **WHEN** PostgreSQL checkpointer creation or setup fails in a production persistence configuration
- **THEN** Agent invoke, stream, and resume operations are rejected and no uncheckpointed graph execution starts

#### Scenario: Development memory mode is explicit
- **WHEN** the application is explicitly configured with the development memory backend
- **THEN** it may execute using an in-memory checkpointer and clearly logs that restart recovery is unavailable

### Requirement: Checkpoint-based reconnect scope
The orchestration layer SHALL support reconnecting callers by returning the latest durable graph state or final response available from the checkpointer and message history. It SHALL NOT represent this behavior as exact replay of token or SSE chunks.

#### Scenario: Final response is already durable
- **WHEN** a caller reconnects after the graph completed and the final response is available in durable state or message history
- **THEN** the service returns that existing response without re-running the graph

#### Scenario: Graph is waiting for external input
- **WHEN** a caller reconnects while the checkpoint contains an interrupt
- **THEN** the service reports the persisted interrupt state without automatically resuming it
