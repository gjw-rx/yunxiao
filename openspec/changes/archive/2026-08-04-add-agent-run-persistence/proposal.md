## Why

现有 LangGraph PostgreSQL checkpointer 已经能够持久化并恢复图状态，`AgentTrace` 也已记录模型回复、工具调用、token 和耗时；重复创建 Step、ToolCall 和 Event 事实表会形成两套执行真相。当前真正缺失的是一次用户请求对应的稳定 Run 身份、请求幂等键、生命周期状态以及与最新 LangGraph checkpoint 的关联。

## What Changes

- 只新增一张轻量 `AgentRun` 表，保存 `run_id`、`session_id`、`client_request_id`、`status`、`last_checkpoint_id` 和通用时间字段。
- 为 `run_id` 建立唯一约束，为 `(session_id, client_request_id)` 建立请求幂等唯一约束；所有关联均使用业务 ID 逻辑关联，不声明数据库外键或级联删除。
- 新增独立于 `InvokeService` 的 Run 仓储/服务边界，负责幂等创建或返回既有 Run、状态查询与转换、checkpoint 关联更新以及可恢复 Run 扫描。
- 复用现有 `AgentTrace`，增加可空 `run_id` 和 `tool_call_id` 字段，使模型与工具观测记录可关联到应用级 Run 和具体工具调用。
- 将 LangGraph checkpoint 明确为唯一的 graph 执行状态来源；不新增 `AgentStep`、`AgentToolCall` 或 `AgentRunEvent`，也不在业务表中复制 graph 节点状态。
- 对初始 graph 执行与 `Command(resume=...)` 续流显式使用 `durability="sync"`。
- 生产环境要求持久 checkpointer 初始化成功；初始化失败时不得降级为无 checkpoint 的 Agent 执行。显式配置的开发内存模式保持可用。
- 本 change 的断线恢复只保证读取 LangGraph checkpoint 中的当前/最终状态，不提供逐 token 或逐 SSE sequence 精确补发。

## Capabilities

### New Capabilities

- `agent-run-persistence`: 定义轻量 AgentRun 的幂等身份、生命周期、checkpoint 关联、恢复扫描以及与 AgentTrace 的逻辑关联契约。

### Modified Capabilities

- `session-orchestration`: 将 LangGraph checkpoint 确立为 graph 执行状态唯一来源，增加同步持久化强度和生产环境 fail-closed 要求。

## Impact

- 云端 Run 域：`app/api/agent/run/` 的模型、仓储和最小 RunService。
- 现有 Trace：`app/api/agent/trace/`、`app/api/agent/middleware/trace.py` 和运行时上下文增加逻辑关联字段。
- LangGraph 基础设施与调用：`app/infrastructure/db/langgraph_backend.py`、初始 invoke/stream 与 resume 路径。
- 数据库初始化：注册一张新 `agent_run` 表，并为 `agent_trace` 补充两列；沿用当前 metadata/create-all 与显式补列机制，本 change 不引入 Alembic。
- 现有 v1 API、SSE 事件格式、VSCode 插件、LangGraph graph 定义和 `InvokeMessage` 数据保持兼容。
- 多实例 thread 互斥、后台计算与 SSE 解耦、工具结果 execution receipt、自动恢复执行器以及精确流重放仍由后续独立 change 处理。
