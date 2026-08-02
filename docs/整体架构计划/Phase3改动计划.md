# Phase 3 云端 Agent 改动计划

> 配套文档：本地插件侧 OpenSpec change `phase3-code-intelligence`（`openspec/changes/phase3-code-intelligence/`）。
> 架构依据：`docs/04-架构演进规划.md` 第二、三、五节（Phase 3 步骤 3.17-3.23）。
> 云端代码路径：`D:\python_project\ai_training`（FastAPI + LangGraph）。
> 前置：Phase 1 云端改动（`docs/整体架构计划/Phase1改动计划.md`）已完成--`tool_call` 事件、`/api/agent/invoke/tool_result` 端点、会话创建接收 `local_tools`、`make_local_tool_wrapper`（interrupt + `Command(resume=...)`）续流。
> 前置：Phase 2 云端改动（`docs/整体架构计划/Phase2改动计划.md`）已完成--`require_approval` 按权限置位、`cancelled` 审批拒绝续流处理。
>
> 本文描述云端为支持「Phase 3 代码智能与上下文检索」必须做的改动。
> **核心结论：Phase 1/2 已建立完整协议与工具包装机制，Phase 3 云端改动很小**--主要是「Agent 系统提示增强」与「大结果裁剪策略」。
> 新增本地工具（`code.get_diagnostics` 等）**无需云端逐个适配**：它们经 `local_tools` 上报后由 `make_local_tool_wrapper` 统一包装，云端自动可见。

---

## 一、背景与目标

Phase 1 跑通了只读工具 `fs.read_file` 的混合编排闭环，Phase 2 补齐了核心文件操作工具集与审批网关。Agent 已能读写文件、做精准编辑，但仍只能把代码当**文本**处理--不能查诊断、按符号定位、找引用、跳定义，更没有代码索引支撑大工作区检索。

Phase 3 本地侧引入**代码智能工具集**（5 个只读工具）与**本地代码索引**：

- `code.get_diagnostics`：查 lint/type 诊断（基于 `vscode.languages.getDiagnostics()`）
- `code.workspace_symbols`：按符号名搜索（基于 `vscode.executeWorkspaceSymbolProvider`）
- `code.find_references`：查引用（基于 `vscode.executeReferenceProvider`）
- `code.go_to_definition`：跳定义（基于 `vscode.executeDefinitionProvider`）
- `code.search_index`：基于本地 trigram 索引的模糊检索

全部新工具均为 `read` 权限、`site: local`，无需审批，经 `local_tools` 自动上报。

云端在 Phase 3 需要：

1. **Agent 系统提示增强**：指导 LLM 何时使用代码智能工具（如「修改代码后用 `get_diagnostics` 验证」「重构前用 `find_references` 找所有调用点」），否则 LLM 不知道这些工具的存在或用法。
2. **大结果裁剪策略**：诊断/引用/符号列表可能很大（大工作区数百条诊断/引用），虽本地已做基础截断（50-100 条上限），云端应确保大结果不撑爆 LLM 上下文窗口。
3. **工具清单上报验证**（步骤 3.23）：Phase 1 已实现 `local_tools` 在会话创建时上报，新工具经此机制自动上报。验证 `code.*` 工具经 `make_local_tool_wrapper` 自动包装即可，**无需额外协议改动**。

> **重要**：与 Phase 2 一样，新工具的 `read` 权限意味着 `require_approval` 始终为 `false`（Phase 2 的 `_require_approval(permissions)` 逻辑：`permissions != "read"` => `true`）。云端无审批相关改动。

---

## 二、现状（Phase 1/2 已建立的契约，无需重复实现）

| 关注点 | 文件 | Phase 1/2 现状（Phase 3 复用） |
| --- | --- | --- |
| `tool_call` 事件 | `app/api/agent/util/stream_protocol.py` | 已支持 `{call_id, tool, args, site, require_approval}` 对象 data。`require_approval` 按 `permissions` 派生（read=false）。 |
| `/tool_result` 端点 | `app/api/agent/invoke/views.py` + `service.py` | 已实现，返回 SSE 续流。请求体含 `status`/`result`/`error`/`metadata`。 |
| 本地工具包装 | `app/api/agent/tool/impl/local_tool_wrapper.py` | `make_local_tool(schema)` 把任意 `LocalToolSchema` 包装为 interrupt 型 LangChain 工具。**新工具自动适配，无需逐个改**。 |
| 会话级本地工具 | `app/api/agent/invoke/service.py` | `create_session(agent_id, local_tools)` 已把 `local_tools` 与 session 绑定，装配时合并进 `create_agent(tools=...)`。 |
| 续流 | `service.py` `resume_stream` | 以 `session_id` 为 `thread_id`，`Command(resume=ToolMessage(...))` 续流，复用 checkpointer 历史。 |
| schema | `app/api/agent/invoke/schemas.py` | `LocalToolSchema` 已含 `permissions` 字段；`InvokeToolResultIn` 已含 `status`/`metadata`。 |
| `require_approval` 派生 | `local_tool_wrapper.py` | `_require_approval(permissions)` -> `permissions != "read"`。新工具全部 `read` -> 自动 `false`。 |

**结论**：Phase 3 不新增端点、不改协议信封、不改 schema 字段、不改包装器逻辑。改动集中在「Agent 系统提示」与「结果裁剪策略」。

---

## 三、协议契约（与本地 spec 对齐）

### 3.1 `tool_call` 事件 -- 新工具自动透传

云端识别到 LLM 请求本地代码智能工具时，`tool_call` 事件格式不变：

```json
{"type":"tool_call","data":{
  "call_id":"c4","tool":"code.get_diagnostics","args":{"file":"src/extension.ts"},
  "site":"local","require_approval":false
}}
```

```json
{"type":"tool_call","data":{
  "call_id":"c5","tool":"code.find_references","args":{"file":"src/extension.ts","line":25,"column":10},
  "site":"local","require_approval":false
}}
```

- `require_approval` 始终为 `false`（全部新工具 `permissions: read`）。
- `args` 由 LLM 生成，经 `make_local_tool_wrapper` 的 `args_schema` 校验后透传。
- `tool_call` 后仍**自然结束当前 SSE 流**（与 Phase 1/2 一致），等 `/tool_result` 续流。

### 3.2 `/tool_result` -- 结构化 JSON 结果

本地工具执行后回传结构化 JSON 字符串作为 `result`：

```json
// code.get_diagnostics
{"session_id":"...","call_id":"c4","status":"success",
 "result":"{\"diagnostics\":[{\"file\":\"src/extension.ts\",\"line\":10,\"column\":5,\"severity\":\"error\",\"message\":\"Cannot find name 'foo'\"}],\"truncated\":false}",
 "metadata":{"duration_ms":15}}

// code.find_references
{"session_id":"...","call_id":"c5","status":"success",
 "result":"{\"references\":[{\"file\":\"src/extension.ts\",\"line\":25,\"column\":10},{\"file\":\"src/utils.ts\",\"line\":8,\"column\":3}],\"truncated\":false}",
 "metadata":{"duration_ms":23}}

// code.search_index
{"session_id":"...","call_id":"c6","status":"success",
 "result":"{\"results\":[{\"file\":\"src/auth.ts\",\"line\":15,\"snippet\":\"function authenticate(token) {...}\",\"score\":0.85}]}",
 "metadata":{"duration_ms":8}}

// 索引未就绪
{"session_id":"...","call_id":"c6","status":"error","error":"索引构建中，请稍后重试"}
```

云端将 `result`（JSON 字符串）注入为 `ToolMessage(content=result, tool_call_id=call_id)`，Agent 据此推理。

- `metadata` Phase 1/2 已定义（`affected_files`/`diff`/`duration_ms`）。Phase 3 代码智能工具仅填充 `duration_ms`；不产生 `diff`/`affected_files`（只读工具不改文件）。
- **无新增 metadata 字段**。

### 3.3 `local_tools` 上报 -- 新工具自动包含

会话创建时，本地 `ToolRegistry.list()` 自动包含新工具 schema：

```json
{"agent_id":"a1","local_tools":[
  {"name":"fs.read_file","description":"...","parameters":{...},"permissions":"read","site":"local"},
  {"name":"code.edit","description":"...","parameters":{...},"permissions":"write","site":"local"},
  {"name":"code.get_diagnostics","description":"查询 lint/type 诊断...","parameters":{...},"permissions":"read","site":"local"},
  {"name":"code.workspace_symbols","description":"按符号名搜索...","parameters":{...},"permissions":"read","site":"local"},
  {"name":"code.find_references","description":"查找引用...","parameters":{...},"permissions":"read","site":"local"},
  {"name":"code.go_to_definition","description":"跳转定义...","parameters":{...},"permissions":"read","site":"local"},
  {"name":"code.search_index","description":"模糊检索代码...","parameters":{...},"permissions":"read","site":"local"}
]}
```

云端 `make_local_tool_wrapper` 自动包装每个 schema，合并进 `create_agent(tools=...)`。**无需逐个适配**。

---

## 四、改动清单（按文件）

### 4.1 Agent 系统提示增强（核心改动）

**文件**：`app/api/agent/` 下 Agent 装配相关的提示模板（如 `armory/factory.py` 中的系统提示拼接，或专门的 prompt 模板文件）。

**做什么**：

在 Agent 系统提示中增加**代码智能工具使用指引**，指导 LLM 何时使用这些工具：

```
## 代码智能工具使用指引

你拥有以下代码智能工具，请在合适场景主动使用：

- `code.get_diagnostics`：查询 lint/type 错误。
  - 修改代码后，用此工具验证是否引入错误（形成"编辑-验证"闭环）。
  - 可查指定文件或全工作区。
- `code.workspace_symbols`：按函数/类/变量名搜索符号。
  - 需要定位某个函数/类定义时，优先用此工具（比全文搜索更精准）。
- `code.find_references`：查找符号的所有引用位置。
  - 重构（改名/删除/修改签名）前，用此工具找出所有调用点。
  - 参数需要 file/line/column（1-based），可先通过 workspace_symbols 或 read_file 获取位置。
- `code.go_to_definition`：跳转到符号定义。
  - 探索代码结构时，从调用点跳到定义。
  - 参数同 find_references（file/line/column，1-based）。
- `code.search_index`：基于本地索引的模糊代码检索。
  - 用于"找到所有处理鉴权的代码"这类语义/模糊查询。
  - 与 fs.search_files 的区别：search_index 做模糊相似度匹配，search_files 做精确正则/glob。

使用建议：
1. 重构流程：workspace_symbols 定位 -> find_references 找调用点 -> code.edit 修改 -> get_diagnostics 验证
2. 代码理解：read_file 读取 -> go_to_definition 跳定义 -> find_references 看用法
3. 大范围搜索：search_index 模糊检索 -> read_file 精读
```

**为什么**：LLM 不知道这些工具的存在（工具 schema 有 description 但 LLM 可能不会主动使用），系统提示层指引成本最低、效果最显著。

**备选**：仅在工具 `description` 中写清楚使用场景 -- 否决（LLM 对长 description 的注意力不如系统提示；但 description 仍应写清楚，作为补充）。

**实现方式**：
- 方案 A（推荐）：在 Agent 装配时，检测 `local_tools` 中是否包含 `code.*` 工具，若有则拼接代码智能指引到系统提示。
- 方案 B：无条件拼接（即使没有 `code.*` 工具也拼，但 LLM 调用不存在工具会被 interrupt 机制正常处理）。
- **建议方案 A**：动态拼接避免无关提示干扰。

### 4.2 大结果裁剪策略（可选但推荐）

**文件**：`app/api/agent/util/stream_protocol.py` 或 `app/api/agent/invoke/service.py`（续流注入 ToolMessage 前）。

**做什么**：

本地已对每个工具做了基础截断（诊断 50 条、符号 100 条、引用 50 个），但云端在注入 `ToolMessage` 前可做**二次裁剪**，防止极端情况：

- 检测 `ToolMessage.content` 长度，超过阈值（如 10K 字符）时：
  - 对 JSON 结果做结构化截断（保留前 N 条 + 附截断标记）
  - 或附加提示：「结果已截断，如需完整结果请缩小查询范围」
- **Phase 3 建议最小实现**：仅做长度检测与日志记录，不实际裁剪（本地截断已足够）。Phase 6 统一裁剪层再做。

**为什么**：防御纵深。本地截断是工具级的，云端裁剪是会话级的（考虑 LLM 上下文窗口总量）。

**备选**：完全信任本地截断 -- 可接受（本地截断上限已设 50-100 条），但极端情况（大工作区全量诊断 + 多轮工具调用累积）可能逼近上下文窗口。

**Phase 3 决策**：**仅日志记录，不实际裁剪**。本地截断 + 工具结果 JSON 结构紧凑（每条诊断/引用约 100 字符，50 条约 5K 字符），实际不会撑爆。Phase 6 做统一裁剪层。

### 4.3 工具清单上报验证（步骤 3.23 -- 无代码改动）

**文件**：无（验证项）。

**做什么**：

验证 Phase 1 已实现的 `local_tools` 上报机制对 Phase 3 新工具正常工作：

1. 本地 `ToolRegistry.list()` 返回的 schema 数组包含 5 个新工具。
2. `create_session(agent_id, local_tools)` 正确接收并存储。
3. `make_local_tool_wrapper` 对每个新工具生成有效的 LangChain `BaseTool`。
4. `create_agent(tools=...)` 合并后 LLM 在工具列表中看到新工具。
5. LLM 调用新工具时，`interrupt` payload 正确生成 `{call_id, tool, args, site, require_approval: false}`。
6. 省略 `local_tools` 时向后兼容（纯聊天不回归）。

**为什么**：Phase 1 的机制设计为「任意 schema 自动包装」，但需验证 `code.*` 工具的参数 schema（含 `file`/`line`/`column` 等）经 LangChain `args_schema` 校验后 LLM 能正确生成参数。

**风险**：Low -- Phase 2 已验证 `fs.write_file`/`code.edit` 等复杂参数 schema 的自动包装，`code.*` 工具参数更简单。

### 4.4 `local_tool_wrapper.py` -- 无代码改动（确认即可）

**文件**：`app/api/agent/tool/impl/local_tool_wrapper.py`

**做什么**：

确认以下行为对 Phase 3 新工具正常：

- `_require_approval(schema.permissions)`：新工具 `permissions: "read"` -> 返回 `false`。✅（Phase 2 逻辑）
- `interrupt` payload 含 `require_approval: false`。✅
- 工具 `description` 透传给 LLM（Phase 1 已透传）。Phase 3 本地侧在 `description` 中写清楚使用场景（如「修改代码后用此工具验证错误」），确认云端不截断/修改 description。✅
- 工具拒绝（`cancelled`）处理：Phase 3 新工具为只读，不会触发审批拒绝；但 `code.search_index` 可能因「索引未就绪」返回 `error`，Phase 1 已处理 `error` status 注入 `ToolMessage`。✅

**结论**：无代码改动。

---

## 五、代码智能工具的多轮调用模式

Phase 3 的典型场景涉及多轮工具调用链（每轮一个 `tool_call` + `/tool_result` 续流）：

```
场景："找出所有调用 getServiceBaseUrl 的地方，改成 getServiceUrl"

轮 1: SSE tool_call: code.workspace_symbols {query: "getServiceBaseUrl"}
     -> /tool_result: {symbols: [{name:"getServiceBaseUrl", file:"src/extension.ts", line:19, ...}]}
轮 2: SSE tool_call: code.find_references {file:"src/extension.ts", line:19, column:10}
     -> /tool_result: {references: [{file:"src/extension.ts",line:25,...}, {file:"src/config.ts",line:8,...}]}
轮 3: SSE tool_call: code.edit {path:"src/extension.ts", oldString:"getServiceBaseUrl", newString:"getServiceUrl"}
     -> /tool_result: {status:"success", metadata:{diff:"...", affected_files:["src/extension.ts"]}}
轮 4: SSE tool_call: code.edit {path:"src/config.ts", oldString:"getServiceBaseUrl", newString:"getServiceUrl"}
     -> /tool_result: {status:"success", ...}
轮 5: SSE tool_call: code.get_diagnostics {file:"src/extension.ts"}
     -> /tool_result: {diagnostics: []}  // 无错误
轮 6: SSE tool_call: code.get_diagnostics {file:"src/config.ts"}
     -> /tool_result: {diagnostics: []}
轮 7: SSE content: "已完成改名，共修改 2 个文件，诊断无错误。"
     -> SSE end
```

**云端要点**：
- 每轮 `tool_call` 后 SSE 流自然 end，`/tool_result` 续流开新 SSE 流（Phase 1 机制）。
- checkpointer 以 `thread_id=session_id` 保留完整历史（AIMessage 含 tool_calls + 对应 ToolMessage），Agent 据此跨轮推理。
- **无新增续流逻辑**--Phase 1 已支持多轮 tool_call 闭环，Phase 2 已验证 write 工具链路，Phase 3 仅工具类型不同。

---

## 六、与本地契约的一致性核对

| 项 | 本地（Phase 3） | 云端（本计划） | 一致 |
| --- | --- | --- | --- |
| `tool_call` 格式 | 解析 `{call_id, tool, args, site, require_approval}` | 透传（Phase 1/2 机制） | ✅ |
| `require_approval` | 不依赖（read 工具不 gate） | `permissions:"read"` -> `false`（Phase 2 逻辑） | ✅ |
| `/tool_result` 响应 | SSE 续流（Phase 1 机制） | 同 | ✅ |
| 结果格式 | JSON 字符串（`{diagnostics:[]}` / `{references:[]}` 等） | 注入 `ToolMessage(content=result)` | ✅ |
| `metadata` | 仅 `duration_ms`（只读工具无 diff/affected_files） | Phase 1/2 已定义，不消费亦不影响 | ✅ |
| 新工具 schema | 经 `local_tools` 上报（Phase 1 机制） | `make_local_tool_wrapper` 自动包装 | ✅（无需逐个适配） |
| 命名空间 | `code.` | 透传 | ✅ |
| 1-based 位置参数 | `line`/`column` 1-based，内部转 0-based | 云端不参与（本地 VSCode API 转换） | ✅ |
| 索引未就绪 | `code.search_index` 返回 `status:"error"` | 注入 `ToolMessage`，Agent 据此等待或改用 `search_files` | ✅ |
| 续流模式 | 流中断 + HTTP 回传 + 内部续流（Phase 1） | 同 | ✅ |
| 系统提示 | 本地不参与（云端 Agent 提示） | 云端增强（4.1） | ✅ |

---

## 七、测试（云端 `tests/api/agent/`）

1. `test_system_prompt_code_intelligence.py`：`create_session` 带 `code.*` 工具时，Agent 系统提示含代码智能指引；不带时不含（方案 A 动态拼接）。
2. `test_local_tool_wrapper_code_tools.py`：`make_local_tool` 对 `code.get_diagnostics`/`code.find_references` 等 schema 产出有效 `BaseTool`；`require_approval` 为 `false`；`interrupt` payload 含正确 `tool`/`args`/`site`。
3. `test_invoke_tool_result_code_intelligence.py`：`/tool_result` 传 `code.get_diagnostics` 的 JSON 结果 -> 续流注入 `ToolMessage`，Agent 据此推理（如「诊断有 2 个错误，需要修复」）。
4. `test_code_intelligence_multi_round.py`：多轮 tool_call 闭环--`workspace_symbols` -> `find_references` -> `code.edit` -> `get_diagnostics`，每轮 `/tool_result` 续流，checkpointer 历史完整。
5. `test_tool_result_large_result.py`（可选）：`/tool_result` 传超大 JSON 结果（模拟 50 条诊断）-> 续流正常，不超 LLM 上下文限制（验证 4.2 裁剪策略）。
6. 回归 Phase 1/2 用例：`test_session_local_tools.py`（新工具自动合并）、`test_resume_continuation.py`（多轮 tool_call 闭环含 code.* 工具）、`test_invoke_tool_result_cancelled.py`（Phase 2 审批拒绝不回归）。

---

## 八、风险与开放问题

- **LLM 不主动使用代码智能工具**（Medium）-> 系统提示增强（4.1）指导 LLM 何时用；工具 `description` 写清楚使用场景。联调时观察 LLM 是否在重构场景主动调用 `find_references`/`get_diagnostics`；若不主动，考虑在 Agent 的 ReAct 提示中增加「修改代码后必须验证」的硬约束。
- **LLM 生成位置参数不准确**（Medium）-> `code.find_references`/`go_to_definition` 需要 `{file, line, column}`，LLM 可能生成错误坐标。缓解：系统提示指引「先用 workspace_symbols 或 read_file 获取准确位置」；工具返回 `error` 时 LLM 据此重试。
- **大结果撑爆上下文**（Low）-> 本地已截断（50-100 条上限，每条约 100 字符，总约 5-10K 字符）；云端 4.2 仅日志记录。Phase 6 统一裁剪层。联调时监控多轮工具调用的累积 token。
- **索引未就绪导致 `search_index` 不可用**（Low）-> 本地返回 `error: "索引构建中"`，云端注入 `ToolMessage`，Agent 据此改用 `fs.search_files` 或等待重试。系统提示可指引：「`search_index` 不可用时改用 `search_files`」。
- **工具清单动态更新**（后续阶段）-> Phase 3 工具在会话创建时一次性上报，不支持运行时增减。若未来需要动态增减工具（如索引器延迟就绪后动态添加 `search_index`），需新增 `PUT /api/agent/invoke/session/{id}/tools` 端点。**Phase 3 不做**--`search_index` 在创建时就上报，索引未就绪时返回 error 即可。
- **批量 `tool_call_batch`**（后续阶段）-> Phase 3 仍每轮至多一个本地 tool_call。重构场景可能需要并行查询多个文件的诊断/引用，批量并行留后续。
- **`code.search_index` vs `fs.search_files` 语义混淆**（Low）-> 系统提示明确区分（4.1）：`search_index` 模糊/相似度，`search_files` 精确正则/glob。工具 description 也写清楚。

---

**文档版本**：v1.0 · **日期**：2026-08-02 · **配套**：本地 OpenSpec change `phase3-code-intelligence` · **前置**：`docs/整体架构计划/Phase1改动计划.md` + `Phase2改动计划.md`
