# Phase 6 云端 Agent 改动计划

> 架构依据：`docs/04-架构演进规划.md` 第二、三、五节（Phase 6 步骤 6.35-6.39）。
> 云端代码路径：`D:\python_project\ai_training`（FastAPI + LangGraph）。
> 前置：Phase 1-4 云端改动已完成--`tool_call`/`tool_result` 续流、`local_tools` 自动包装、权限信息透传、取消结果处理、代码/终端/Git 工具提示和基础大结果日志。
> 本文描述 Phase 6 为支持「安全、可靠性与边界处理」必须同步的云端改动。

## 一、结论与边界

Phase 6 的路径安全、危险命令拦截、审批、进程终止、文件版本冲突和结果首次脱敏属于本地插件职责，云端不执行这些检查，也不接触工作区内容。

云端仍需配合以下四类行为：

1. **结果契约扩展**：透传并记录 `retryable`、`truncated`、`redacted` 等可选 metadata，保证旧客户端不受影响。
2. **续流可靠性**：对 `(session_id, call_id)` 做幂等，避免重复 `/tool_result` 重复注入 ToolMessage 或重复启动 Agent。
3. **会话级上下文保护**：在多轮工具调用中对结果做二次长度/token 预算检查，并把裁剪标记保留给 Agent。
4. **错误策略与系统提示**：区分取消、不可重试错误和可重试错误；遇到拒绝、超时、冲突或裁剪结果时调整策略，不重复同一危险动作。

**核心结论**：不新增传输协议、不新增云端工具执行器、不要求 `tool_call_batch`。现有 `tool_call` + `/api/agent/invoke/tool_result` 继续作为唯一续流通道。

## 二、现状（Phase 1-4 已建立的契约）

| 关注点    | 现状                                        | Phase 6 处理              |
| ------ | ----------------------------------------- | ----------------------- |
| 本地工具发现 | 会话创建上报 `local_tools`，云端自动包装               | 不变，新工具无需逐个适配            |
| 工具调用   | SSE `tool_call` 后结束当前流                    | 不变                      |
| 结果回传   | `/api/agent/invoke/tool_result` 返回 SSE 续流 | 增加幂等、结果预算和 metadata 语义  |
| 审批     | 本地依据 `permissions` 强制执行                   | 云端只透传/记录，不参与审批          |
| 本地安全   | pathGuard、ShellWhitelist、本地审批             | 云端不重复判断                 |
| 大结果    | 本地工具级截断，云端已有日志                            | 增加会话级二次预算检查             |
| 取消/失败  | `cancelled` / `error` 注入 ToolMessage      | 明确不重试规则和 `retryable` 语义 |

## 三、协议契约

### 3.1 `tool_call` SSE 事件

事件格式不变：

```json
{
  "type": "tool_call",
  "data": {
    "call_id": "c1",
    "tool": "fs.read_file",
    "args": { "path": "src/extension.ts" },
    "site": "local",
    "require_approval": false
  }
}
```

`require_approval` 仍是信息性字段。云端不得因该字段等待审批回调或替代本地权限矩阵；本地插件始终以工具 schema 的 `permissions` 为权威。

### 3.2 `/api/agent/invoke/tool_result`

请求沿用现有信封，`metadata` 增加可选字段：

```json
{
  "session_id": "s1",
  "call_id": "c1",
  "status": "success | error | cancelled",
  "result": "<bounded result>",
  "error": "<optional human-readable reason>",
  "metadata": {
    "affected_files": [],
    "diff": "",
    "duration_ms": 120,
    "retryable": false,
    "truncated": true,
    "redacted": true
  }
}
```

约束：

- `session_id + call_id` 是幂等键；首次接受后记录结果状态，重复请求不得再次注入 ToolMessage 或再次启动续流。
- `cancelled` 是正常控制流，不是 5xx；云端注入 ToolMessage 后续流，但不得自动重试同一调用。
- `error` 是否允许 Agent 调整后重试由 `metadata.retryable` 和工具副作用类型共同决定，缺省按不可重试处理。
- `truncated` / `redacted` 必须保留在会话可观测信息中；注入给 Agent 的内容只能是本地已经裁剪/脱敏后的 `result`。
- 旧客户端不发送新增 metadata 时，按 Phase 1-4 行为处理。

### 3.3 续流与重复提交

首次有效 `tool_result` 仍返回新的 SSE 流。对于重复提交，优先返回此前续流的幂等状态/结果；如果无法安全重放流，则返回标准成功响应并标记 `duplicate: true`，不得重新调用 LangGraph。

服务端需在 checkpointer 或会话状态中保存至少：`call_id`、结果状态、是否已注入 ToolMessage、续流是否已启动。清理策略与会话 TTL 一致，不能因普通 HTTP 重试立即删除幂等记录。

## 四、改动清单（按文件）

### 4.1 `app/api/agent/invoke/schemas.py` — 扩展可选 metadata

- 为 `tool_result.metadata` 增加 `retryable: bool | None`、`truncated: bool | None`、`redacted: bool | None`。
- 保持额外字段可选，兼容 Phase 1-4 客户端。
- 不把本地审计详情、原始路径敏感信息或 stack trace 加入公共 schema。

### 4.2 `app/api/agent/invoke/service.py` — 幂等与结果注入

- 在处理 `/tool_result` 前按 `session_id`、`call_id` 查询已处理记录。
- 首次提交：写入幂等记录，构造一条与 `call_id` 匹配的 `ToolMessage`，再启动续流。
- 重复提交：返回已有处理状态，不重复追加 ToolMessage，不重复调用 `ainvoke`/`astream_events`。
- `cancelled` 注入清晰的人类可读原因，例如“用户拒绝或取消了该工具调用”；不得驱动同参数自动重试。
- `error` 注入错误原因和必要的 `retryable` 标记；缺少标记时按不可重试处理。
- 续流中再次出现 `tool_call` 时沿用现有单调用闭环，不因 Phase 6 改动改变 SSE 生命周期。

### 4.3 `app/api/agent/invoke/views.py` — 保持端点兼容并补充幂等响应

- 保持 `POST /api/agent/invoke/tool_result` 路径与 SSE 响应不变。
- 对同一 `session_id/call_id` 的重复请求返回标准成功/幂等响应，禁止返回误导性的 5xx。
- 4xx 仅用于 schema、会话或 call_id 无效等客户端错误；网络/内部续流故障仍按现有错误封装处理。

### 4.4 `app/api/agent/util/stream_protocol.py` — 结果预算与可观测性

- 在把 `result` 组装为 `ToolMessage` 前执行会话级字符/token 预算检查。
- 若超出预算，只对已接收的 bounded result 做二次裁剪，不尝试向本地索取完整内容。
- 记录 `session_id`、`call_id`、原始长度估算、注入长度、`truncated`、`redacted`、`retryable`；日志不得写入原始敏感内容。
- 继续透传 content/thought/tool_call/end 等事件，不新增 WebSocket 或新的续流入口。

### 4.5 Agent 系统提示模板 — 边界结果处理指引

在已有代码智能、终端/Git 指引后追加动态规则：

- 收到 `cancelled`：理解为用户拒绝/取消或本地安全拦截，不重复同一调用；必要时询问用户或改用只读方案。
- 收到不可重试 `error`：解释原因并换用合法路径、非交互命令或其他工具，不盲目重试。
- 收到 `retryable=true`：最多进行有限次数的策略调整后重试，避免重复有副作用的写入/提交。
- 收到 `truncated` 或 `redacted`：承认上下文不完整，改用分页、范围查询或定向搜索；不得猜测被隐藏的内容。
- 收到并发冲突：先重新读取当前内容，再生成基于最新版本的编辑，不覆盖用户变更。

### 4.6 云端测试 `tests/api/agent/`

新增或补充：

1. 首次 `tool_result` 只注入一条 ToolMessage 并返回续流。
2. 同一 `session_id/call_id` 重复提交不重复注入、不重复启动 Agent。
3. `cancelled` 结果续流一次且不重复同一 tool_call。
4. `error + retryable=false` 不自动重试；`retryable=true` 只允许受限策略恢复。
5. `truncated`/`redacted` metadata 透传并触发会话预算日志，ToolMessage 不包含原始内容。
6. 旧客户端缺省 metadata 和缺省 `local_tools` 时保持兼容。
7. 回归 Phase 1-4：多轮续流、审批拒绝、终端超时、Git 工具、系统提示代码智能指引。

## 五、云端不改动的部分

- 不实现 `securityAudit`、pathGuard、ShellWhitelist 或本地审批。
- 不读取、缓存或上传本地原始文件和未脱敏终端输出。
- 不根据 `require_approval` 触发云端审批流程。
- 不要求本地新增云端工具执行器；Phase 6 的新边界通过既有 `local_tools` 和 `tool_result` 传递。
- 不在本阶段强制启用并行 `tool_call_batch`；本地默认顺序执行仍是兼容路径。

## 六、联调与发布顺序

1. 先发布云端兼容改动：可选 metadata、幂等、取消/错误语义和预算日志。
2. 部署本地 Phase 6 结果治理与会话状态改动；旧云端仍可消费基础 `result`。
3. 联调异常矩阵：断网重试、重复提交、取消、超时、结果裁剪/脱敏、并发冲突。
4. 观察重复续流率、ToolMessage 注入失败率、裁剪率、重试次数和敏感信息告警，再决定是否开放可并行只读工具。

## 七、风险与开放问题

- **幂等记录存储位置**：优先复用会话/checkpointer 状态；若现有状态无法安全保存，增加短 TTL 的服务端幂等存储。
- **token 估算差异**：若云端模型 tokenizer 不统一，先使用字符预算并记录估算值，后续按实际模型接入 tokenizer。
- **重复请求与 SSE 已断开**：幂等记录必须区分“已注入”和“续流已完成”，避免客户端重连造成重复 Agent 调用。
- **副作用工具重试**：默认不重放 write/execute/destructive；只有未来具备明确幂等键时才允许服务端恢复。
- **敏感信息误报**：云端只接受本地脱敏结果，服务端二次裁剪不恢复原文；必要时通过本地规则迭代降低误报。

---

**文档版本**：v1.0 · **日期**：2026-08-03 · **配套**：本地 OpenSpec change `phase6-security-reliability` · **前置**：`docs/整体架构计划/Phase1改动计划.md` + `Phase2改动计划.md` + `Phase3改动计划.md` + `Phase4改动计划.md`
