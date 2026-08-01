# Phase 1 云端 Agent 改动计划

> 配套文档：本地插件侧 OpenSpec change `phase1-local-tool-calling`（`openspec/changes/phase1-local-tool-calling/`）。
> 架构依据：`docs/04-架构演进规划.md` 第三、九节。
> 云端代码路径：`D:\python_project\ai_training`（FastAPI + LangGraph）。
>
> 本文描述云端为支持「本地工具调用」在 Phase 1 必须做的改动。本地侧已实现并经 mock 云端验证；
> 云端就绪后双方按本文契约联调（对应本地 tasks 11.7）。

---

## 一、背景与目标

云端 Agent 当前是「全云端编排」：LLM 决策、工具执行、流式推送全部在云端完成（`stream_agent_events` 通过 `agent.astream_events` 把图内工具执行以 `tool_start`/`tool_end` 推送给客户端）。Phase 1 要演进为「混合编排」：云端 Agent 决策，**本地工具**（如 `fs.read_file`）由插件执行，结果回传后续流。

Phase 1 最小闭环：用户「读 src/extension.ts 并总结」→ 云端 LLM 决定调 `fs.read_file` → 云端通过 SSE 下发 `tool_call` 并结束流 → 插件本地读文件 → 插件 `POST /tool_result` → 云端注入结果、续流 → 返回总结。

---

## 二、现状（关键文件与行号）

| 关注点       | 文件                                                                     | 现状                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE 事件生成 | `app/api/agent/util/stream_protocol.py`                                | `stream_agent_events(agent, user_message, thread_id, context)`（L111）基于 `agent.astream_events(version="v2")`，仅 yield `content`/`thought`/`tool_start`/`tool_end`（L145-165）。`_to_json_line(type, data)`（L18）格式 `{"type":..,"data":<string>}`。**无 `tool_call` 事件**。 |
| 流式端点     | `app/api/agent/invoke/views.py`                                        | `POST /api/agent/invoke/message/stream`（L77）返回 `StreamingResponse`，`sse_generator` 调 `svc.chat_stream` 并 `data: {line}\n\n`（L118）。**无 `/tool_result` 端点**。                                                                                                                 |
| 会话创建     | `views.py` L33 + `invoke/schemas.py` L10 + `invoke/service.py` L41 | `InvokeSessionCreate` 仅 `agent_id`。`create_session(agent_id)` 生成 `session_id`(=thread_id) 并触发装配。**无 `local_tools` 字段**。                                                                                                                                                      |
| 流式调用     | `app/api/agent/invoke/service.py`                                      | `chat_stream(agent_id, session_id, text)`（L249）→ `stream_agent_events`。`session_id` 作为 LangGraph `thread_id`（L287），checkpointer 保留短期记忆。                                                                                                                                            |
| Agent 装配   | `app/api/agent/armory/factory.py`                                      | `build_armory(tool_registry, ...)`（L60）逆序装配 RootNode→AiApiNode→ChatModelNode→AgentNode→RunnerNode；RunnerNode 内 `create_agent(tools=...)` 编译图。                                                                                                                                          |
| 工具注册     | `app/api/agent/tool/registry.py`                                       | `ToolRegistry`（L25）持 `ToolEntry`，`build_langchain_tools(tool_names, toolset)`（L85）产出 `BaseTool[]` 供 `create_agent(tools=...)`；`register(entry)`（L126）支持动态注册。                                                                                                                |
| 响应约定     | `app/core/rest/response.py` + `app/core/exc_lib/`                    | `success(data=...)` → `{success:true, data:...}`；错误 `BasicException(BaseErrorInfo...)`。本地插件已按 `{success, data, error}` 信封解析。                                                                                                                                                       |

---

## 三、协议契约（与本地 `tool-call-protocol` spec 对齐，Design B）

### 3.1 `tool_call` SSE 事件

云端识别到 LLM 请求 **本地工具**（`site=local`）时，在流中 yield：

```json
{"type":"tool_call","data":{"call_id":"c1","tool":"fs.read_file","args":{"path":"src/extension.ts"},"site":"local","require_approval":false}}
```

随后 **自然结束该 SSE 流**（不再 yield 其它事件）。注意：`data` 为**对象**（区别于 `content`/`thought` 的字符串 data），需扩展 `_to_json_line` 支持对象 data（见 3.3 改动）。

> 保留 `tool_start`/`tool_end` 用于**云端工具**（图内执行完毕后推送），仅新增 `tool_call` 用于**本地工具**调用请求。

### 3.2 `POST /api/agent/invoke/tool_result`（返回 SSE 续流）

请求体：

```json
{
  "session_id": "string",
  "call_id": "string",
  "status": "success | error | cancelled",
  "result": "string",
  "error": "string?",
  "metadata": {"affected_files?":[],"diff?":"","duration_ms?":0}
}
```

响应：**SSE 流**（`text/event-stream`）。云端将工具结果注入 LangGraph 状态、续流（`agent.astream_events`），把后续事件（content / thought / 进一步 `tool_call` / end）作为响应体流式返回。流结束即本轮完成；若续流中再次出现 `tool_call`，进入下一轮（插件再次回传）。

- 4xx 错误用标准信封 `{success:false, error}`（JSON，非流）。
- `/tool_result` 是续流的唯一入口——无需单独的 continue 端点。

### 3.3 会话创建接收 `local_tools`

`POST /api/agent/invoke/session` body 增加可选 `local_tools`：

```json
{"agent_id":"a1","local_tools":[{"name":"fs.read_file","description":"...","parameters":{...},"permissions":"read","site":"local"}]}
```

云端装配时把 `local_tools` 合并进 Agent 工具集（LLM 可见）。**省略 `local_tools` 时行为不变**（纯聊天，向后兼容）。

### 3.4 工具命名空间

本地工具统一前缀 `fs.` / `code.` / `terminal.` / `git.`，云端保持原名透传给 LLM 与 `tool_call` 事件，避免与云端工具冲突。

---

## 四、改动清单（按文件）

### 4.1 `app/api/agent/invoke/schemas.py` — 新增 schema

- 新增 `LocalToolSchema(BaseModel)`：`name: str`、`description: str`、`parameters: dict`、`permissions: str`、`site: str`。
- 新增 `InvokeToolResultIn(BaseModel)`：`session_id: str`、`call_id: str`、`status: Literal["success","error","cancelled"]`、`result: str | None = None`、`error: str | None = None`、`metadata: dict | None = None`。
- `InvokeSessionCreate` 增字段 `local_tools: list[LocalToolSchema] | None = None`。

### 4.2 `app/api/agent/invoke/service.py` — 会话级本地工具 + 续流

- `create_session(agent_id, local_tools=None)`：把 `local_tools` 与 `session_id` 绑定存储（建议存入 `InvokeSession` 新字段 `local_tools: JSON`，或 session 级 `LocalToolRegistry`），供 `chat_stream` 装配时合并。
- `chat_stream(agent_id, session_id, text)`：装配 Agent 时，把本会话的 `local_tools` 转为 LangChain 工具（见 4.4）并入 `create_agent(tools=...)`。
- 新增 `resume_stream(session_id, call_id, status, result, error)`：以 `session_id` 为 `thread_id`，用 `Command(resume=ToolMessage(content=result, tool_call_id=call_id))` 续流（见 4.5），`async for` `astream_events` yield 续流 JSON 行。
- 失败/`cancelled` 结果同样以 `ToolMessage`（content=error 或 "cancelled"）注入，让 Agent 据此调整策略。

### 4.3 `app/api/agent/invoke/views.py` — 新增 `/tool_result` 端点

```python
@router.post("/tool_result")
async def submit_tool_result(
    body: InvokeToolResultIn = Body(...),
    state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    svc = InvokeService(state=state, session=db)
    sess = await svc.get_session(body.session_id)
    if sess is None:
        raise BasicException(BaseErrorInfo.ERROR_UN_KNOW, f"会话不存在: {body.session_id}", clew=body.session_id)

    async def sse_generator() -> AsyncIterator[str]:
        async for line in svc.resume_stream(sess.agent_id, body.session_id, body.call_id, body.status, body.result, body.error):
            yield f"data: {line}\n\n"

    return StreamingResponse(sse_generator(), media_type="text/event-stream")
```

`create_session` 视图把 `body.local_tools` 透传给 `svc.create_session(agent_id, local_tools)`。

### 4.4 `app/api/agent/tool/` — 本地工具包装为 LangChain 工具

本地工具在云端**没有执行体**，仅声明 schema。需把它包装成「调用即中断」的 LangChain `BaseTool`：

- 新增 `app/api/agent/tool/impl/local_tool_wrapper.py`：`make_local_tool(schema: LocalToolSchema) -> BaseTool`。
  - `name`/`description`/`args_schema` 取自 schema。
  - `_arun(**args)` 内部调用 LangGraph `interrupt({"call_id":..., "tool":..., "args":...})`（HITL 模式）——图在此暂停，控制权回到流层。
- 装配时（`ChatModelNode` 或 `RunnerNode` 调 `build_langchain_tools`）合并 `local_tools` 包装器与云端工具，统一传给 `create_agent(tools=...)`。
- 可在 `ToolEntry` 或包装器上标记 `site="local"`，便于路由/可观测。

### 4.5 `app/api/agent/util/stream_protocol.py` — 发射 `tool_call` + 续流

- 扩展 `_to_json_line` 或新增 `_to_json_line_obj(msg_type, data_obj)`，支持 `tool_call` 的对象 data。
- 修改 `stream_agent_events`（或在其调用层）：
  - 当图因 `interrupt` 暂停（本地工具调用）时，从 interrupt payload 提取 `{call_id, tool, args, site, require_approval}`，yield `tool_call` 行，然后**结束迭代**（流自然 end）。
  - 续流路径 `resume_stream` 复用同一函数：以 `agent.astream_events(Command(resume=...), config={thread_id})` 驱动，事件转 JSON 行（含可能的下一个 `tool_call`）。
- LangGraph `interrupt`/`Command(resume=...)` 是原生 HITL，配合现有 checkpointer（`thread_id=session_id`）天然保留完整工具调用历史（AIMessage 含 tool_calls + 对应 ToolMessage）。

### 4.6 `app/api/agent/invoke/models.py`（可选）

- `InvokeSession` 增字段 `local_tools: Mapped[...] | JSON`（若选择落库存储），或仅内存 session 级缓存。

---

## 五、续流正确性要点

- **thread_id 复用**：`/tool_result` 续流必须用同一 `session_id` 作 `thread_id`，使 checkpointer 历史包含上一轮 AIMessage（含 `tool_calls`）与新注入的 `ToolMessage`，Agent 据此推理。
- **工具消息成对**：每个 `tool_call.call_id` 对应一条 `ToolMessage(tool_call_id=call_id)`，成对注入。
- **取消/失败处理**：插件回传 `status=cancelled`/`error` 时，云端注入对应 `ToolMessage`（content=原因），让 Agent 询问替代方案而非死循环重试同一工具。
- **多轮**：续流中可再次 `tool_call`（下一本地工具），插件再次回传，循环直至 content 流结束。

---

## 六、与本地契约的一致性核对

| 项                      | 本地（已实现）                                    | 云端（本计划）                      | 一致 |
| ----------------------- | ------------------------------------------------- | ----------------------------------- | ---- |
| SSE 信封                | `{type, data}`，`{success:false}` 错误信封    | 同                                  | ✅   |
| `tool_call` data 形态 | 对象`{call_id,tool,args,site,require_approval}` | 对象                                | ✅   |
| `/tool_result` 响应   | SSE 续流（Design B）                              | SSE 续流                            | ✅   |
| `local_tools` 上报    | `createSession(agentId, localTools?)`           | `InvokeSessionCreate.local_tools` | ✅   |
| 命名空间                | `fs.`/`code.`/...                             | 透传                                | ✅   |
| 取消语义                | 回传`cancelled`                                 | 注入 ToolMessage 调整策略           | ✅   |

---

## 七、测试（云端 `tests/api/agent/`）

1. `test_stream_protocol_tool_call.py`：mock agent 在 interrupt 时，`stream_agent_events` yield `tool_call` 行并结束。
2. `test_invoke_tool_result.py`：`/tool_result` 端点——成功/错误/取消三种 status，续流返回 content；4xx 返回错误信封。
3. `test_session_local_tools.py`：`create_session` 带 `local_tools`，装配后 LLM 工具集含本地工具；不带时向后兼容。
4. `test_resume_continuation.py`：续流复用 thread_id，历史含 tool_calls + ToolMessage；多轮 tool_call 闭环。

---

## 八、风险与开放问题

- **LangGraph interrupt 与 `astream_events` 的协作**：需确认 `astream_events` 在图 interrupt 时的行为（是否抛出/如何捕获 interrupt payload）。若 `astream_events` 不便捕获 interrupt，可改用 `agent.astream` + 检查 `__interrupt__`，或自定义 tool node 在调用本地工具前直接 yield `tool_call` 并 `return`（非 interrupt 方案）。**建议先 spike 验证 interrupt + astream_events**。
- **`local_tools` 存储位置**：落库（`InvokeSession.local_tools` JSON）还是内存 session 级缓存——取决于是否需要重启后恢复会话工具集。Phase 1 建议内存即可。
- **审批字段 `require_approval`**：Phase 1 本地无审批网关，云端始终发 `require_approval:false`；Phase 2 接入审批网关后再启用。
- **批量 `tool_call_batch`**：Phase 1 每轮至多一个本地 tool_call（本地侧已据此实现）；批量并行留待后续阶段，届时 `/tool_result` 需支持一次回传多个结果。

---

**文档版本**：v1.0 · **日期**：2026-08-01 · **配套**：本地 OpenSpec change `phase1-local-tool-calling`
