## Why

当前 `/message/stream` 与 `/tool_result` 把 LangGraph 计算生命周期绑定在单个 SSE 响应生成器上：客户端断线会关闭生成器，导致计算、结果归档和 Run 状态都可能随订阅一起终止。已有 `AgentRun` 与有序 `AgentRunEvent` 已提供稳定身份和重放存储，现在需要把“执行一次 Run”与“订阅 Run 事件”拆成两个独立边界。

## What Changes

- 新增独立的 Run 计算协调器：请求先幂等准入 Run，再由后台任务驱动初始计算或工具结果续算；计算不归 SSE 响应所有。
- 将稳定的流事件写入 `AgentRunEvent`，并在 Run 生命周期变化时写入明确的状态事件。
- 新增按 `run_id` 与排他 `after_sequence` 游标读取/订阅事件的接口；订阅先补发已提交事件，再等待新事件，直到 Run 终态。
- v1 `/message/stream` 与 `/tool_result` 保持现有 SSE JSON 事件兼容，但内部改为“启动/续算 Run + 订阅事件”，SSE 断开不取消后台计算。
- 新增 v2 Run 命令与事件订阅接口，显式接收 `client_request_id`、返回 `run_id`，并支持断线后从 sequence 游标恢复。
- 明确本 change 不实现跨实例 lease、startup recovery worker、工具 execution receipt、token delta 批量策略或插件 RunStore。

## Capabilities

### New Capabilities

- `run-compute-subscription`: 定义 Run 计算所有权、后台执行、终态收敛、游标 replay/订阅以及 v1/v2 API 行为。

### Modified Capabilities

- `run-event-sequencing`: 将稳定的计算输出和生命周期事件接入现有 RunEvent 顺序日志，并定义订阅方的游标读取语义。
- `session-orchestration`: 云端 SSE 断开后计算继续，重连通过 Run sequence 恢复；插件本地终态不再等价于云端计算终态。

## Impact

- 云端后端：`app/api/agent/run/`、`app/api/agent/invoke/`、`app/api/agent/util/stream_protocol.py` 与 `AppState` 生命周期。
- HTTP API：保留现有 v1 路径，新增显式 Run v2 命令/查询/事件订阅路径。
- 数据库：复用现有 `agent_run` 与 `agent_run_event`，本 change 不新增表和迁移框架。
- 测试：增加计算与订阅解耦、SSE 断线、sequence replay、幂等准入、终态和 v1 兼容回归测试。
