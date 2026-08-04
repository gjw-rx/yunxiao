## Context

当前云端存在三类不同数据：

- `InvokeSession` / `InvokeMessage`：用户可见的会话与干净消息历史；
- LangGraph `AsyncPostgresSaver`：按 `thread_id=session_id` 保存 graph checkpoint、待执行节点和 interrupt；
- `AgentTrace`：保存模型回复、思考、工具参数/结果、token 和耗时，用于观测与审计。

LangGraph checkpoint 已经具备 graph 状态恢复能力，`interrupt()` / `Command(resume=...)` 也已用于 VSCode 本地工具续流。旧设计再增加 Step、ToolCall 和 RunEvent 表，会同时在 checkpointer、Trace 和业务表中描述同一执行过程，容易产生不一致。

真正缺少的是 checkpointer 不负责的服务控制信息：一次用户请求的稳定 `run_id`、客户端重试幂等键、对外生命周期状态、最新 checkpoint 关联以及重启扫描入口。本 change 因此收缩为“一张 AgentRun + 扩展 AgentTrace + 强化 LangGraph 持久化策略”。

## Goals / Non-Goals

**Goals:**

- 只新增一张轻量 `AgentRun` 表，作为请求准入和运行状态索引，而不是 graph 状态副本。
- 通过 `(session_id, client_request_id)` 唯一约束提供跨进程请求幂等基础。
- 提供独立 RunService，支持幂等创建、状态查询/转换、checkpoint 关联更新和可恢复 Run 扫描。
- 让 `AgentTrace` 通过 `run_id` / `tool_call_id` 关联应用 Run 与工具调用，复用已有观测内容。
- 让 LangGraph checkpointer 成为 graph 节点、任务、interrupt 和恢复位置的唯一事实来源。
- 初始执行和 resume 都使用同步 durability，生产持久 checkpointer 不可用时停止 Agent 执行。

**Non-Goals:**

- 不新增 `AgentStep`、`AgentToolCall` 或 `AgentRunEvent`。
- 不把 LangGraph State、节点输出、interrupt payload 或 token stream 复制到 `AgentRun`。
- 不实现逐 token/SSE sequence 持久化与精确补发。
- 不实现后台 Run worker、启动时自动推进、分布式 lease 或同 thread 多实例互斥。
- 不实现 tool result hash、execution receipt 或非幂等工具执行日志。
- 不迁移到 LangGraph Agent Server，不修改插件 RunStore 或 Webview。
- 不在本 change 引入 Alembic。

## Decisions

### 1. LangGraph checkpoint 是唯一 graph 执行状态来源

Graph 当前执行到哪个节点、有哪些 pending task、是否处于 interrupt、恢复时从哪里继续，统一读取 `AsyncPostgresSaver` 的 checkpoint。业务表不保存 Step 或 ToolCall 状态机。

选择复用 checkpointer，是因为 LangGraph 已在 super-step 边界保存 StateSnapshot 和 interrupt，并能通过相同 `thread_id` 恢复。自建 Step/ToolCall 表既无法替代 checkpoint，又会要求维护双写一致性。

`AgentRun.last_checkpoint_id` 只是面向查询和诊断的逻辑指针，不是 checkpoint 内容副本，也不对 LangGraph checkpoint 表声明外键。

### 2. AgentRun 只保存服务控制字段

`AgentRun` 沿用 `Base + CustomBase`，字段限定为：

- `run_id: str`：应用级稳定 Run ID，唯一且有索引；
- `session_id: str`：逻辑关联 `InvokeSession.session_id` / LangGraph `thread_id`；
- `client_request_id: str`：客户端一次逻辑请求的稳定 ID；
- `status: str`：`pending | running | interrupted | completed | failed | cancelled`；
- `last_checkpoint_id: str | None`：最近确认的 LangGraph checkpoint ID；
- `create_time` / `update_time`：由 `CustomBase` 提供。

不保存 `agent_id`、输入/输出 JSON、Step、ToolCall 或 event cursor；这些信息分别已存在于 Session、checkpoint、Trace 和消息历史中。

数据库建立 `run_id` 唯一约束、`(session_id, client_request_id)` 唯一约束以及 session/status 查询索引。`session_id` 和 `last_checkpoint_id` 均为逻辑关联，禁止数据库外键和级联删除。

### 3. RunService 与 InvokeService 分离

新增 `RunRepository` 和 `RunService`：

- `create_or_get(session_id, client_request_id)`：首次创建 Run，重复请求返回既有 Run；
- `get(run_id)`：按稳定 ID 查询；
- `transition(run_id, expected_statuses, target_status)`：执行受控状态转换；
- `record_checkpoint(run_id, checkpoint_id, status)`：更新 checkpoint 逻辑指针和状态；
- `list_recoverable()`：扫描 `pending` / `running` Run，供后续 startup recovery worker 使用。

仓储不自动 commit、不吞掉 `IntegrityError`。RunService 在自己的事务边界内处理唯一约束竞争：并发创建发生冲突时回读 `(session_id, client_request_id)` 对应 Run，而不是创建第二条记录。

本 change 只提供扫描结果，不自动重新调用 graph。自动恢复、lease 和多实例所有权属于后续 `add-run-idempotency-and-recovery`。

### 4. 复用并关联 AgentTrace

`AgentTraceModel` 增加：

- `run_id: str | None`：逻辑关联应用级 AgentRun；
- `tool_call_id: str | None`：工具 trace 对应的 LangChain/LangGraph tool call ID。

两列保持 nullable，使存量 trace 和尚未接入 RunService 的 v1 路径继续可读。Trace 中的模型回复、工具参数/结果和 token 不迁移、不复制。

`TraceEntry`、Trace middleware 和 runtime context 增加相应字段；工具 middleware 从现有 `request.tool_call["id"]` 获取 `tool_call_id`。这里的应用级 `run_id` 不能使用 `astream_events` 中随机生成的 Runnable `event["run_id"]`。

Trace 仍是 best-effort 可观测记录：写入失败不影响 graph 主流程。因此它不能用于请求准入、恢复位置或工具幂等判断。

### 5. 幂等键由 AgentRun 保证，但接入 API 后置

数据库唯一约束 `(session_id, client_request_id)` 是跨进程幂等基础。当前 change 建立模型和服务契约，不修改 v1 请求体，也不声称现有 `/message/stream` 已获得端到端重试幂等。

后续命令/API change 接入时，必须在写入第二条用户消息或启动 graph 前调用 `create_or_get`；只有 `created=True` 才能创建用户消息并启动执行。重复请求根据既有 Run 状态返回当前结果或订阅指引。

这样可以保持本 change 手术式，同时避免为了接入幂等而提前重构 v1 SSE。

### 6. 初始执行和 resume 使用同步 durability

所有持久 graph 的 `ainvoke` / `astream` / `astream_events` 初始执行和 `Command(resume=...)` 调用显式传入 `durability="sync"`。这要求每个 super-step 的 checkpoint 成功持久化后才开始下一步，降低服务崩溃时重复执行已完成节点的窗口。

同步 durability 不能让外部副作用自动幂等。包含网络调用、文件写入或数据库写入的节点仍必须遵守 LangGraph replay 规则，后续本地工具 execution receipt 负责非幂等执行保护。

### 7. 生产 checkpointer fail-closed

显式开发配置 `memory_backend="memory"` 时允许 `InMemorySaver`。生产配置要求 PostgreSQL 时：

- checkpointer 创建或 `setup()` 失败必须保留错误并阻止 Agent invoke/stream/resume；
- 不得退化为 `checkpointer=None` 后继续无持久化执行；
- Store/embedding 的失败是否允许独立降级，不得连带隐藏 checkpointer 失败。

选择 fail-closed 是因为一旦返回“已接受运行”却没有 checkpoint，重启恢复承诺即不成立。

### 8. 不保留 AgentRunEvent

本 change 的重连语义是：根据 `run_id` 找到 `session_id` / `last_checkpoint_id`，读取 LangGraph 当前或最终 State，并从消息历史/State 返回现有结果。它不重放断线期间的每个 token 或 SSE chunk。

如果未来产品要求 `Last-Event-ID` 式精确流恢复，需要单独新增事件存储能力，或迁移到支持 resumable stream 的 LangGraph Agent Server；不能把该能力隐藏在本 change 中。

### 9. 同 thread 互斥后置且只选一种实现

LangGraph OSS checkpointer不提供同一 `thread_id` 的多实例 Run 排队或互斥。后续 change 必须在 Redis 锁、任务队列或 PostgreSQL advisory lock 中选择一种机制，并在取得所有权后才推进 graph。

本 change 不预埋 lease 字段，也不通过数据库外键表达所有权。

## Risks / Trade-offs

- [没有 AgentRunEvent，断线后无法补发遗漏 token] → 明确只恢复当前/最终状态；精确流重放单独立项。
- [AgentRun 与 checkpoint 不是原子写入] → `last_checkpoint_id` 只作诊断指针，恢复事实始终以 checkpointer 为准；后续 RunService 在 graph 边界收敛状态。
- [Trace 的 `run_id` 允许为空] → 保持存量和 v1 兼容；接入新 Run 命令后以测试要求新路径必须填充。
- [同步 durability 增加每个 super-step 的数据库等待] → 以恢复一致性换取少量延迟，并通过集成测试记录基线。
- [生产 fail-closed 降低数据库故障时的可用性] → durable Run 是明确承诺，宁可拒绝新执行也不产生无法恢复的半运行。
- [RunService 尚未接入 v1] → 本 change 只建立稳定边界；后续 API change 在不破坏 v1 的前提下接入 `client_request_id`。
- [逻辑关联可能产生孤立 AgentRun/Trace] → 由维护查询和保留策略治理，不依赖数据库级联删除。

## Migration Plan

1. 先增加 RED 测试，锁定单表字段、唯一约束、无外键、RunService 幂等竞争和状态转换。
2. 新增 `AgentRun`、仓储和最小 RunService，并注册到共享 metadata。
3. 为 `agent_trace` 增加 nullable `run_id` / `tool_call_id`，更新显式补列逻辑和 Trace 映射。
4. 在 graph 初始执行与 resume 路径显式设置同步 durability。
5. 拆分 checkpointer 与 Store 初始化失败处理，生产 checkpointer 失败时拒绝执行，开发内存模式保持可用。
6. 运行模型/服务/Trace/LangGraph 基础设施测试、Ruff 和现有 v1 Agent API 回归。
7. 回滚时恢复旧调用策略；新增 `agent_run` 空表和 Trace nullable 列可保留，不影响旧版本读取。

## Open Questions

- 后续同 thread 多实例互斥采用 Redis、任务队列还是 PostgreSQL advisory lock，需要结合部署拓扑在 `add-run-idempotency-and-recovery` 中确定。
- 如果产品重新确认必须逐 token/SSE sequence 补发，应单独恢复事件存储 change 或评估 Agent Server，不能在当前单表设计中临时加入 RunEvent。
- 生产环境是否要求先建立 Alembic 基线；若要求，应作为独立数据库治理 change。
