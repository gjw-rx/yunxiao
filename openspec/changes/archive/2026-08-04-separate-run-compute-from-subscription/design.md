## Context

现有 `InvokeService.chat_stream` / `resume_stream` 直接被 FastAPI `StreamingResponse` 的生成器迭代。生成器既驱动 LangGraph，又向客户端写 SSE，并在 `finally` 中做消息归档；因此 HTTP 订阅一旦断开，生成器关闭就会传播到计算链路。前两个 P1 change 已提供轻量 `AgentRun`、同步 LangGraph durability，以及以 Run 行锁分配 sequence 的 `AgentRunEvent`，但生产链路尚未使用这些边界。

本项目通过 `AppState` 持有进程级资源，使用 SQLAlchemy async session factory，当前没有队列、Redis、advisory lock 或跨实例任务所有权协议。本 change 需要在这些约束内先建立清晰的单实例计算/订阅边界，同时避免把未来的 lease 和自动恢复语义写死。

## Goals / Non-Goals

**Goals:**

- 让一次 Run 的 LangGraph 计算由独立后台任务拥有，不由任意 SSE 订阅者拥有。
- 通过 `client_request_id` 幂等准入 Run，并使 v2 调用方获得稳定 `run_id`。
- 将现有 JSON 行协议事件按 Run sequence 持久化，并原子记录 `running`、`interrupted`、`completed`、`failed` 终态事件。
- 支持从排他 `after_sequence` 游标补发事件，然后继续观察新事件直至 Run 终态。
- 保持 v1 `/message/stream` 与 `/tool_result` 的事件负载兼容，且 v1 断线不取消计算。
- 使计算、订阅与 HTTP 适配器可分别单元测试。

**Non-Goals:**

- 不实现跨实例 lease、同一 thread 的分布式互斥、队列或 startup recovery worker。
- 不实现工具 execution receipt、结果 hash 或非幂等工具 exactly-once。
- 不实现插件 RunStore、workspace cursor 或 Webview 时间线。
- 不实现 token delta 批量持久化和预算控制；这些属于后续预算 change。
- 不迁移 LangGraph Agent Server，不新增数据库表或 Alembic。

## Decisions

### 1. 新增 RunComputeService，后台任务拥有计算

HTTP 命令调用 `RunComputeService.start` 或 `resume`。服务先在短事务中完成 Run 准入/状态转换，再使用 `asyncio.create_task` 启动独立协程；协程内部自行创建数据库 session 和 `InvokeService`，不会捕获请求级 session。`AppState` 只保存 `run_id -> Task` 的进程内注册表，用于避免同一进程重复启动和在应用关闭时取消未完成任务。

不让 `StreamingResponse` 生成器创建或 await LangGraph 事件流，因为客户端断开会取消该生成器。也不在本 change 引入外部队列，因为尚无 lease 和 worker 所有权协议；多实例恢复属于下一独立 change。

### 2. RunEvent payload 保存现有协议对象

计算协程解析 `InvokeService` 产出的每条 JSON 行，将其完整协议对象（`type`、`data`）作为 `AgentRunEvent.payload` 保存，并以 `type` 作为 `event_type`。这样 v1 订阅可以重新序列化原对象而无需转换，v2 则额外暴露数据库 `sequence` 和 `event_type`。

Run 生命周期使用 `run_status` 事件，payload 包含 `run_id`、`session_id` 和新状态。扩展 `RunEventService` 提供“锁 Run 行、校验期望状态、更新状态、追加事件、推进 sequence”的单事务方法，避免终态已经可见但终态事件尚未提交的窗口。`tool_call` 与紧随其后的 `interrupted` 状态事件也在同一事务内连续分配 sequence，避免插件在状态尚未切换时提前回传结果。

### 3. tool_call 决定 interrupted，其余正常流结束决定 completed

后台计算记录本轮是否出现 `tool_call`：

- 出现 `tool_call` 时，Run 从 `running` 转为 `interrupted`，等待工具结果；
- 未出现时，Run 从 `running` 转为 `completed`；
- 未捕获异常使 Run 转为 `failed`，并写入不包含堆栈和敏感参数的失败状态事件。

工具结果续算必须显式绑定 `run_id`，v2 始终要求该字段。v1 为兼容旧客户端允许省略，后端按该 session 最新的 `interrupted` Run 解析；不存在或状态不匹配时返回冲突，不猜测其他状态。

### 4. 订阅采用数据库游标轮询

`RunSubscriptionService.iter_events` 每轮调用 `list_after` 读取一批已提交事件，逐条 yield 并推进本地游标；无新事件时读取 Run 状态。只有在 Run 已终态且游标已追平时结束，否则短暂 `asyncio.sleep` 后继续。

数据库轮询同时适用于同进程和其他实例写入，不依赖易丢失的内存通知。它比 LISTEN/NOTIFY 延迟略高，但实现和故障语义更简单；轮询间隔作为模块常量而非公开配置，后续可在性能基准后替换。

### 5. v1 是兼容适配器，v2 暴露 Run 事实

新增 `/api/agent/run` 路由：

- `POST /api/agent/run`：要求 `session_id`、`text`、`client_request_id`，返回 `run_id`、是否新建及状态；
- `POST /api/agent/run/{run_id}/tool-result`：提交该 Run 的工具结果并启动续算；
- `GET /api/agent/run/{run_id}`：读取状态和最新 sequence；
- `GET /api/agent/run/{run_id}/events?after_sequence=N`：以 SSE 输出带 sequence 的事件信封。

现有 v1 streaming 路由内部调用同一计算服务，再订阅对应 Run；请求模型新增可选 `client_request_id` / `run_id`，省略时生成兼容 ID 或按 interrupted Run 解析。v1 只输出原 JSON 行协议，响应头携带 `X-Run-ID`。

### 6. 归档由计算协程完成

用户消息在 Run 首次准入成功后归档一次；重复 `client_request_id` 不重复归档。assistant 文本由持久事件累积，并在本轮正常结束时通过独立短 session 归档。订阅者只读取事件，不承担业务写入，因此零订阅和多订阅不会改变消息历史。

## Risks / Trade-offs

- [进程在后台任务完成前退出会留下 `pending/running` Run] → 保留可恢复状态并明确交给后续 startup recovery worker；本 change 不谎报完成。
- [没有 lease 时两个实例仍可能尝试续算同一 thread] → 状态条件转换拒绝明显重复命令，但不能替代分布式互斥；v2 要求稳定 `run_id` 为后续 lease 提供入口。
- [逐 token/逐 chunk 写数据库放大 I/O] → 先保证正确重放；后续 change 按时间或大小批量化 content delta。
- [轮询增加数据库读负载与最多一个轮询周期的延迟] → 使用有界批次和适度间隔；后续可替换为通知唤醒而不改变 sequence 协议。
- [v1 无 client request id 时无法跨请求幂等] → 兼容路径生成一次性 ID；可靠调用方应传可选字段或迁移 v2。
- [旧插件不认识 `run_status`] → v1 适配器不转发内部生命周期事件，只转发现有协议事件；v2 提供完整时间线。

## Migration Plan

1. 先增加计算服务、订阅服务与 API 的 RED 测试，锁定断线、重放、幂等和终态行为。
2. 扩展 Run 仓储/事件服务的条件状态变更与按 session 查找 interrupted Run。
3. 实现后台计算、事件持久化和消息归档，并在 `AppState` 注册任务。
4. 新增 v2 路由，再将 v1 streaming 路由改为兼容适配器。
5. 运行定向测试、扩大回归、Ruff 和 OpenSpec strict validate。

回滚时恢复旧 v1 适配器即可；新增的 RunEvent 数据可以保留。部署滚动升级期间，新旧实例不应同时接受同一 session 的续算命令，因为 lease 尚未实现。

## Open Questions

无。跨实例任务所有权、恢复 worker 与 content delta 批量参数留给后续 change 决定。
