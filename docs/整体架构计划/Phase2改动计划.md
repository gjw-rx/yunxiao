# Phase 2 云端 Agent 改动计划

> 配套文档：本地插件侧 OpenSpec change `phase2-core-file-tools`（`openspec/changes/phase2-core-file-tools/`）。
> 架构依据：`docs/04-架构演进规划.md` 第二、三、五节（Phase 2 步骤 2.9-2.16）。
> 云端代码路径：`D:\python_project\ai_training`（FastAPI + LangGraph）。
> 前置：Phase 1 云端改动（`docs/整体架构计划/Phase1改动计划.md`）已完成--`tool_call` 事件、`/api/agent/invoke/tool_result` 端点、会话创建接收 `local_tools`、`make_local_tool_wrapper`（interrupt + `Command(resume=...)`）续流。
>
> 本文描述云端为支持「Phase 2 核心文件操作工具集 + 审批网关」必须做的改动。
> **核心结论：Phase 1 已建立完整线协议，Phase 2 云端改动很小**--主要是「按权限置 `require_approval`」与「正确处理审批拒绝（`cancelled`）」。
> 新增本地工具（`fs.write_file` 等）**无需云端逐个适配**：它们经 `local_tools` 上报后由 `make_local_tool_wrapper` 统一包装，云端自动可见。

---

## 一、背景与目标

Phase 1 跑通了只读工具 `fs.read_file` 的混合编排闭环。Phase 2 本地侧引入**变更类工具**：`fs.write_file` / `fs.list_dir` / `fs.search_files` / `fs.delete_file` / `fs.move_file` / `code.edit`，并建立**审批网关**--所有 `write`/`execute`/`destructive` 权限工具执行前须经用户确认，用户可拒绝（回传 `cancelled`）。

云端在 Phase 2 需要：

1. **按权限置 `require_approval`**：识别本地工具的 `permissions`，对写/破坏性工具在 `tool_call` 事件中置 `require_approval: true`（Phase 1 始终发 `false`）。
2. **正确处理审批拒绝**：本地回传 `status: cancelled` 时，注入 `ToolMessage` 让 Agent 据此调整策略（询问替代方案 / 放弃），**不重试同一工具**。
3. **接收编辑元数据**（可选）：`code.edit` 成功回传 `metadata.diff` / `metadata.affected_files`，云端可选地在 UI 或 Agent 上下文中呈现。

> **重要**：本地路由层**以工具自身 `permissions` 为准**强制审批（防御纵深），**不依赖**云端 `require_approval` 标志。因此即使云端漏置位，本地写工具仍会弹审批。云端的 `require_approval` 仅为信息性提示与可观测性用途。云端就绪前，本地可用 mock 云端跑通全部 Phase 2 场景。

---

## 二、现状（Phase 1 已建立的契约，无需重复实现）

| 关注点 | 文件 | Phase 1 现状（Phase 2 复用） |
| --- | --- | --- |
| `tool_call` 事件 | `app/api/agent/util/stream_protocol.py` | 已支持 `{call_id, tool, args, site, require_approval}` 对象 data。**但 `require_approval` 始终发 `false`**。 |
| `/tool_result` 端点 | `app/api/agent/invoke/views.py` + `service.py` | 已实现，返回 SSE 续流。请求体已含 `status: success\|error\|cancelled`、`metadata: {affected_files?, diff?, duration_ms?}`。 |
| 本地工具包装 | `app/api/agent/tool/impl/local_tool_wrapper.py` | `make_local_tool(schema)` 把任意 `LocalToolSchema` 包装为 interrupt 型 LangChain 工具。**新工具自动适配，无需逐个改**。 |
| 会话级本地工具 | `app/api/agent/invoke/service.py` | `create_session(agent_id, local_tools)` 已把 `local_tools` 与 session 绑定，装配时合并进 `create_agent(tools=...)`。 |
| 续流 | `service.py` `resume_stream` | 以 `session_id` 为 `thread_id`，`Command(resume=ToolMessage(...))` 续流，复用 checkpointer 历史。 |
| schema | `app/api/agent/invoke/schemas.py` | `LocalToolSchema` 已含 `permissions` 字段；`InvokeToolResultIn` 已含 `status`/`metadata`。 |

**结论**：Phase 2 不新增端点、不改协议信封、不改 schema 字段。改动集中在「`require_approval` 取值逻辑」与「`cancelled` 的 Agent 行为」。

---

## 三、协议契约（与本地 spec 对齐）

### 3.1 `tool_call` 事件 -- `require_approval` 按权限置位

云端识别到 LLM 请求本地工具时，按该工具的 `permissions`（来自会话创建时上报的 `local_tools`）决定 `require_approval`：

```json
{"type":"tool_call","data":{
  "call_id":"c2","tool":"fs.write_file","args":{"path":"src/utils/logger.ts","content":"..."},
  "site":"local","require_approval":true
}}
```

| 工具 permissions | `require_approval` |
| --- | --- |
| `read`（`fs.read_file` / `fs.list_dir` / `fs.search_files`） | `false` |
| `write`（`fs.write_file` / `fs.move_file` / `code.edit`） | `true` |
| `destructive`（`fs.delete_file`） | `true` |
| `execute`（Phase 4 终端） | `true` |

> 取值由 `make_local_tool_wrapper` 在构造 interrupt payload 时从 `schema.permissions` 派生（见 4.1）。本地侧不依赖此值，但正确置位便于可观测与未来云端 UI 提示。

### 3.2 `/tool_result` -- `cancelled` 审批拒绝

本地用户拒绝审批时，回传：

```json
{"session_id":"...","call_id":"c2","status":"cancelled","error":"用户拒绝执行"}
```

云端将之注入为 `ToolMessage(content="用户拒绝了该工具调用：用户拒绝执行", tool_call_id=c2)`，Agent 据此推理（如：改用其他方式、询问用户、放弃该步骤）。**云端不应自动重试同一工具调用**（否则陷入「Agent 再调 -> 再被拒」死循环）。

### 3.3 `/tool_result` -- `code.edit` 成功元数据（可选呈现）

```json
{"session_id":"...","call_id":"c3","status":"success","result":"已应用 1 处编辑",
 "metadata":{"affected_files":["src/extension.ts"],"diff":"--- a/...\n+++ b/...\n@@ ...","duration_ms":12}}
```

`metadata.diff` / `metadata.affected_files` Phase 1 已定义。Phase 2 由 `code.edit` 填充。云端**可选**：在 UI 工具调用卡片展示 diff，或把 `affected_files` 注入 Agent 上下文辅助后续推理。**非必须**--不消费也不影响闭环。

---

## 四、改动清单（按文件）

### 4.1 `app/api/agent/tool/impl/local_tool_wrapper.py` -- 派生 `require_approval`

- `make_local_tool(schema: LocalToolSchema)`：在 interrupt payload 中增加 `require_approval` 字段，取值 `schema.permissions not in ("read",)`（即非只读则 true）。
  ```python
  def _require_approval(permissions: str) -> bool:
      return permissions != "read"
  # interrupt payload:
  # {"call_id":..., "tool":schema.name, "args":..., "site":"local",
  #  "require_approval": _require_approval(schema.permissions)}
  ```
- **理由**：`permissions` 在 `LocalToolSchema` 上已有（Phase 1 上报），无需额外信息；包装器是构造 interrupt payload 的唯一出口，在此派生最内聚。
- **备选**：在 `stream_protocol.py` 发射 `tool_call` 时查表 -- 否决（包装器已持有 schema，查表需再传映射，分散）。

### 4.2 `app/api/agent/util/stream_protocol.py` -- 透传 `require_approval`

- 发射 `tool_call` 行时，从 interrupt payload 取 `require_approval`（Phase 1 可能已透传，确认即可）。
- 若 Phase 1 实现已把整个 interrupt payload 作为 `tool_call` data 透传，则**本项无代码改动**，仅需验证字段存在。
- 确认 `tool_call` 后仍**自然结束当前 SSE 流**（与 Phase 1 一致），等 `/tool_result` 续流。

### 4.3 `app/api/agent/invoke/service.py` -- `cancelled` 注入与防重试

- `resume_stream(...)` 处理 `status="cancelled"`：注入 `ToolMessage(content=f"用户拒绝了该工具调用：{error or 'cancelled'}", tool_call_id=call_id)`（Phase 1 已对 error/cancelled 注入 ToolMessage，**确认 content 语义清晰**，让 Agent 明知是用户拒绝而非工具故障）。
- **防重试**（关键）：在 Agent 的系统提示或工具描述中约定--收到「用户拒绝」的 ToolMessage 时，**不要立即重试同一工具同一参数**，应改换策略或询问用户。
  - 实现方式（任选其一，推荐 A）：
    - A. 在 `make_local_tool_wrapper` 的 `description` 末尾追加提示：「若用户拒绝执行，请改用其他方式或询问用户，不要重复调用相同参数。」
    - B. 在 Agent 系统提示模板中加入工具拒绝处理指引。
  - **理由**：LangGraph 不会自动重试（interrupt 已把控制权交回 LLM），但 LLM 可能自发再调同一工具；提示层约束成本最低。
- `status="error"`（非审批拒绝，如 pathGuard 越界、diff 冲突）：保持 Phase 1 行为，注入 ToolMessage 让 Agent 据错误信息调整。

### 4.4（可选）`app/api/agent/invoke/views.py` 或 UI 层 -- 呈现 diff 元数据

- 若云端 UI 有工具调用卡片，可在 `tool_result` 续流的首个事件中把 `metadata.diff` 推给前端展示（新增一个 `tool_diff` SSE 事件或复用 `tool_end` 携带 diff）。
- **非必须**：Phase 2 本地侧已在 VSCode diff 编辑器预览，云端不呈现也不影响功能。留作体验优化，可推迟。

---

## 五、审批拒绝的正确性要点

- **`cancelled` 是正常控制流，非错误**：用户拒绝是预期内的交互结果，云端不应把它当 5xx/异常处理，而应作为 `ToolMessage` 让 Agent 推理。
- **成对注入**：每个 `tool_call.call_id` 对应一条 `ToolMessage(tool_call_id=call_id)`，无论 `success`/`error`/`cancelled` 都必须成对（Phase 1 已保证，Phase 2 无变化）。
- **thread_id 复用**：`/tool_result` 续流用同一 `session_id` 作 `thread_id`，checkpointer 历史含上一轮 AIMessage（含 `tool_calls`）与新 `ToolMessage`（Phase 1 已保证）。
- **多轮**：续流中可再次 `tool_call`（下一本地工具，如先 `list_dir` 再 `write_file` 再 `code.edit`），插件多次回传，循环直至 content 流结束（Phase 1 已支持）。
- **`code.edit` 冲突（`error`）vs 审批拒绝（`cancelled`）**：两者都是「未应用」，但语义不同--
  - 冲突（`error`，如「上下文不匹配」「多处匹配」）：Agent 可重读文件后重试（参数可能需更新）。
  - 拒绝（`cancelled`）：Agent 不应重试相同参数。
  - 云端注入的 ToolMessage content 应区分二者（本地已在 `error`/`cancelled` 字段区分，云端透传即可）。

---

## 六、与本地契约的一致性核对

| 项 | 本地（Phase 2） | 云端（本计划） | 一致 |
| --- | --- | --- | --- |
| `tool_call.require_approval` | 本地不依赖（按自身 permission 判定） | 按 `permissions` 置位（read=false，其余=true） | ✅（云端信息性，本地权威） |
| `/tool_result` `cancelled` | 审批拒绝 -> 回传 `cancelled` | 注入 ToolMessage，Agent 调整不重试 | ✅ |
| `/tool_result` `metadata.diff`/`affected_files` | `code.edit` 成功填充 | 可选呈现，不消费亦不影响 | ✅ |
| 新工具 schema | 经 `local_tools` 上报（Phase 1 机制） | `make_local_tool_wrapper` 自动包装 | ✅（无需逐个适配） |
| 命名空间 | `fs.`/`code.` | 透传 | ✅ |
| 续流模式 | 流中断 + HTTP 回传 + 内部续流（Phase 1） | 同 | ✅ |
| 路径安全 | pathGuard 本地强制 | 云端不参与（本地安全边界） | ✅ |

---

## 七、测试（云端 `tests/api/agent/`）

1. `test_local_tool_wrapper_require_approval.py`：`make_local_tool` 对 `permissions=read` 产出 `require_approval=false`；对 `write`/`destructive` 产出 `true`。
2. `test_stream_protocol_require_approval.py`：mock agent interrupt 时，`tool_call` 事件的 `require_approval` 与包装器派生值一致。
3. `test_invoke_tool_result_cancelled.py`：`/tool_result` 传 `status=cancelled` -> 续流注入 ToolMessage（content 含「拒绝」语义），Agent 不重试相同 tool_call（断言续流中无相同 `tool_call`）。
4. `test_invoke_tool_result_diff_metadata.py`（可选）：`/tool_result` 传 `metadata.diff` -> 续流正常，diff 可被消费（若实现 4.4）。
5. 回归 Phase 1 用例：`test_session_local_tools.py`（新工具自动合并）、`test_resume_continuation.py`（多轮 tool_call 闭环，含 write -> edit 链路）。

---

## 八、风险与开放问题

- **LLM 自发重试被拒工具**（Medium）-> 靠工具描述/系统提示约束（4.3-A）；若仍频繁重试，可考虑在云端加「同 call_id 已 cancelled 则拒绝再次 interrupt 同参数」的短期记忆护栏（Phase 2 暂不做，观察联调表现）。
- **`require_approval` 与本地判定不一致**（Low）-> 本地以自身 `permissions` 为准（防御纵深），云端置位错误不会导致本地漏审批；仅影响云端可观测性。联调时核对两端 `permissions` 取值一致。
- **`metadata.diff` 体积**（Low）-> 大 diff 占用 `/tool_result` body 与 token；本地 `code.edit` 生成的是文件级 unified diff，通常可控。若极端情况，可考虑截断或仅回传 `affected_files`（推迟优化）。
- **审批等待与续流超时**（Medium）-> 本地审批弹窗是同步 await，可能耗时较长；云端 `/tool_result` 续流由本地主动发起，云端无需设短超时（HTTP 请求级超时已由 Phase 1 处理）。确认云端无「会话空闲超时」误杀待审批会话。
- **批量 `tool_call_batch`**（后续阶段）-> Phase 2 仍每轮至多一个本地 tool_call（本地侧 Phase 1 约定）；批量并行留后续，届时 `/tool_result` 需支持多结果回传。

---

**文档版本**：v1.0 · **日期**：2026-08-02 · **配套**：本地 OpenSpec change `phase2-core-file-tools` · **前置**：`docs/整体架构计划/Phase1改动计划.md`
