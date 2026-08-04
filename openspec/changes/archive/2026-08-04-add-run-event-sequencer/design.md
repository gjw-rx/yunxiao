## Context

上一项 P1 change 已建立轻量 `AgentRun`：它负责请求准入、生命周期和 checkpoint 诊断指针，LangGraph checkpointer 仍是 graph 状态唯一事实来源。当前没有稳定的 Run 事件日志，SSE 断线后也没有可供后续 replay API 使用的 sequence。

本 change 只建立数据库层的追加与读取协议。目标数据库是 PostgreSQL，项目当前通过 SQLAlchemy async session、共享 metadata/create-all 和显式补列兼容存量表，尚未接入 Alembic。现有 `RunRepository` 不 commit，事务由调用方控制。

## Goals / Non-Goals

**Goals:**

- 在同一 Run 内分配从 1 开始、严格递增且唯一的事件 sequence。
- 使用 PostgreSQL Run 行锁串行化同一 Run 的并发追加，不使用聚合查询计算下一个序号。
- 在一个事务内完成锁定、sequence 分配、事件插入与 Run 游标推进。
- 失败或回滚时同时撤销事件和游标推进。
- 支持按 `after_sequence` 游标升序读取一个 Run 的事件。
- 兼容已存在的 `agent_run` 表，并保持 Run 与事件之间为逻辑关联。

**Non-Goals:**

- 不将 LangGraph state、checkpoint、step、pending task 或 interrupt payload 复制为事件。
- 不在本 change 接入 v1/v2 命令 API、SSE 生产链路或 token 批量策略。
- 不实现订阅重连、长轮询、WebSocket、插件 RunStore 或 Webview 时间线。
- 不实现 client request 幂等、事件 producer 幂等键、tool receipt、result hash 或 exactly-once 工具执行。
- 不实现 resume lease、同 thread 跨实例互斥、队列或 startup recovery worker。
- 不引入 Alembic，也不迁移 LangGraph Agent Server。

## Decisions

### 1. 使用 AgentRun 行上的 `next_event_sequence` 作为分配器

`AgentRun.next_event_sequence` 初始值为 1。追加事件时使用 `SELECT ... FOR UPDATE` 锁定目标 Run 行，读取当前值作为事件 sequence，再将游标加一。

不采用 `max(sequence) + 1`，因为聚合读取不能稳定串行化并发写入；也不使用数据库全局 sequence，因为需求是每个 Run 独立从 1 排序。行锁只竞争同一 Run，不同 Run 可以并发追加。

### 2. 新增轻量 AgentRunEvent，不复制 graph 状态

事件表保存：

- `run_id`：逻辑关联 AgentRun；
- `sequence`：Run 内序号；
- `event_type`：稳定的事件类别字符串；
- `payload`：JSON 事件数据；
- 通用主键和创建/更新时间。

数据库通过 `(run_id, sequence)` 唯一约束提供最终防线，并通过 `(run_id, sequence)` 索引服务游标读取。`run_id` 不建立数据库外键，保持与既有 Run/Trace/checkpoint 的逻辑关联策略一致，也避免级联删除改变审计记录。

### 3. 一个服务方法拥有完整追加事务

`RunEventService.append` 使用独立 async session，并在 `session.begin()` 中调用仓储的 `lock_by_run_id`、构造事件、推进游标和 flush。服务不在事务提交前返回成功；异常由 context manager 回滚后继续抛出。

仓储保持 transaction-neutral：只构造带 `FOR UPDATE` 的查询、add/flush 和游标查询，不 commit、不吞异常。这样事务边界可直接审计，也能避免调用方忘记把事件和游标放在同一事务。

该方法要求传入的 session 开始时没有活动事务。后续计算/订阅 change 若需要把事件与其他业务写入合并，应新增显式的同事务入口，而不是弱化本 change 的原子性。

### 4. 游标读取只定义稳定顺序，不承诺在线订阅

`list_after(run_id, after_sequence, limit)` 只返回 `sequence > after_sequence` 的事件，按 sequence 升序并限制条数。`after_sequence` 默认 0，`limit` 必须为正数。

本 change 不定义 replay HTTP/SSE 协议、等待新事件或计算完成判定；这些属于后续计算/订阅解耦 change。

### 5. 沿用当前显式补列迁移策略

新部署由 metadata/create-all 创建 `agent_run_event`。对于已存在的 `agent_run`，启动兼容逻辑增加非空、默认值为 1 的 `next_event_sequence` 列。补列必须幂等。

由于当前项目没有 Alembic，本 change 不单独引入迁移框架。未来接入 Alembic 时应把该列和事件表纳入基线。

## Risks / Trade-offs

- [长事务持有 Run 行锁会阻塞同 Run 追加] → 追加事务只包含一次锁定、一次 insert 和一次游标更新，不执行网络或 graph 工作。
- [无 producer 幂等键时调用方重试可能产生语义重复事件] → 本 change 仅保证 sequence 唯一；事件幂等与 tool receipt 留给后续独立 change。
- [逻辑关联允许孤立事件] → 服务必须先锁定存在的 Run 才能追加；仓储是内部边界，不对 API 直接暴露。
- [create-all 不会修改存量表] → 启动时执行幂等补列，并用测试锁定 PostgreSQL/SQLite 方言 SQL。
- [SQLite 不实现 PostgreSQL 行锁语义] → 单元测试校验 `FOR UPDATE` 查询与事务顺序；真实并发保证由 PostgreSQL 定向集成测试验证，环境缺依赖时明确记录。

## Migration Plan

1. 先增加 metadata、行锁追加、回滚和游标读取 RED 测试。
2. 为 `AgentRun` 增加 `next_event_sequence`，新增 `AgentRunEvent` 并注册共享 metadata。
3. 增加幂等补列逻辑，使存量 `agent_run` 的游标从 1 开始。
4. 实现 transaction-neutral 仓储与拥有完整事务的 `RunEventService`。
5. 运行定向测试、Ruff、OpenSpec validate；可用 PostgreSQL 时补跑并发集成测试。

回滚应用版本时可以保留新增列和事件表；旧版本不会读取它们。若必须回滚 schema，应先停止事件生产，再删除事件表和游标列。

## Open Questions

无。本 change 不提前决定 SSE 事件类型全集、payload 版本协议或 token delta 批量大小。
