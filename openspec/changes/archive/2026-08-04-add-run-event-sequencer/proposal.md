## Why

持久化 `AgentRun` 已提供稳定的请求级身份，但 SSE/token 等对外事件仍没有 Run 内的稳定顺序和可重放事实来源。P1 的下一步需要先建立并发安全的事件追加协议，后续计算/订阅解耦和插件 replay 才能共享同一套 sequence 语义。

## What Changes

- 为每个 `AgentRun` 增加单调递增的事件序号游标，并新增轻量 `AgentRunEvent` 持久化模型。
- 新增事务中追加 Run 事件的仓储/服务边界：锁定目标 Run 行、分配下一个 sequence、写入事件并推进游标。
- 通过 `(run_id, sequence)` 唯一约束和调用方事务边界保证同一 Run 内 sequence 唯一、连续；不同 Run 独立排序。
- 明确失败事务不得消耗 sequence 或留下孤立事件，禁止使用 `max(sequence) + 1` 分配序号。
- 提供按 Run 和 sequence 游标升序读取事件的最小查询能力，为后续 replay API 留出稳定基础。
- 沿用现有 metadata/create-all 与显式补列机制兼容已存在的 `agent_run` 表；本 change 不引入 Alembic。

## Capabilities

### New Capabilities

- `run-event-sequencing`: 定义 Run 事件的持久化结构、行锁序号分配、原子追加、回滚和游标读取语义。

### Modified Capabilities

无。事件游标是新 `run-event-sequencing` 能力的一部分，不改变现有会话编排规范。

## Impact

- 云端 Run 域：`app/api/agent/run/` 的模型、仓储和服务。
- 数据库初始化：注册 `agent_run_event` 表，并为存量 `agent_run` 补充事件序号游标列。
- 测试：Run metadata、事务追加、并发序号、回滚及游标读取。
- 现有 v1 API、SSE 格式、LangGraph checkpoint、插件、Webview、lease/recovery 和工具 execution receipt 均不在本 change 修改范围内。
