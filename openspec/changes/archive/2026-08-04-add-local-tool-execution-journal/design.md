## Context

`RunStore` 已能保存 Run 的游标与事件，但它明确不保存工具执行回执。当前 `ToolRouter` 在审批完成后直接执行工具，扩展宿主在该调用期间退出、超时或断线时，不存在可供恢复路径判断的持久记录。写文件、执行终端命令和破坏性工具无法安全地自动再执行。

## Goals / Non-Goals

**Goals:**

- 为非只读本地工具提供工作区级、持久化且最小的执行回执。
- 让同一执行标识的完成结果可复用，并让未完成回执显式转为不可重试的 `unknown`。
- 保持 read 工具的现有直通与并行语义，且不改变审批、安全审计或云端 API。

**Non-Goals:**

- 不自动重放 `unknown` 工具、不推断副作用是否实际落地，也不提供撤销功能。
- 不持久化完整工具参数、完整输出或任何文件内容。
- 不实现跨窗口同步、云端 execution receipt、租约或 scoped approval；这些由后续 change 负责。

## Decisions

### 将 journal 持久化到 workspaceState

新增 `ToolExecutionJournal`，在一个版本化的 workspace-state key 下保存有界记录。记录仅含运行范围、`call_id`、工具名、状态及终态 `ToolResult`；不保存参数或未截断输出。该方案与 `RunStore` 相同，宿主重启后仍可读取，且不引入工作区文件或数据库迁移。文件日志被拒绝，因为它增加用户可见文件、清理与迁移责任。

### 仅为副作用权限写入回执

`read` 工具保持无 journal 的原有路径，并继续允许标记为可并行。`write`、`execute` 与 `destructive` 工具在审批与安全审计通过后、调用 `execute` 前原子写入 `started`。这样被拒绝或被审计拦截的调用不会留下“已执行”的假象。

### 使用运行范围加 call ID 作为身份，并 fail closed

journal 以优先使用的 `runId` 与 `call_id` 定位；旧 v1 流没有 Run ID 时，以 session ID 作为兼容运行范围。遇到已完成回执时直接返回保存的结果；遇到 `started` 回执时返回 `status: error`、`metadata.retryable: false` 和 `metadata.execution_state: unknown`，不调用工具。将 `started` 解释为“未执行”会导致重复副作用，因此被拒绝。

### 在工具 Promise 拒绝时完成错误回执

若路由已开始工具调用且工具 Promise 正常拒绝，路由将保存不可重试的 error 结果后重新抛出，让既有 SessionManager 继续负责事件与续流。宿主崩溃或被超时中断而未得到路由终态时，记录保留 `started` 并在下次尝试时安全阻断。

## Risks / Trade-offs

- [workspaceState 配额被 journal 占用] → 每个 scope 仅保留有界数量的记录，且只保存最终结果的最小字段。
- [同一 v1 session 复用 call ID] → v2 优先使用 Run ID；旧流以 session 范围隔离，终态回执只在同一 scope 的相同 call ID 被复用。
- [工具超时后底层副作用继续执行] → `started` 不被覆盖为成功，恢复时返回 `unknown`，要求人工或云端重新决策。
- [完成后、写回执前进程退出] → 下次读取仍为 `started` 并 fail closed。
