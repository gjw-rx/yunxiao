# Phase 4 云端 Agent 改动计划

> 配套文档：本地插件侧 OpenSpec change `phase4-terminal-git-integration`（`openspec/changes/phase4-terminal-git-integration/`）。
> 架构依据：`docs/04-架构演进规划.md` 第二、三、五节（Phase 4 步骤 4.24-4.27）。
> 云端代码路径：`D:\python_project\ai_training`（FastAPI + LangGraph）。
> 前置：Phase 1 云端改动（`docs/整体架构计划/Phase1改动计划.md`）已完成--`tool_call` 事件、`/api/agent/invoke/tool_result` 端点、会话创建接收 `local_tools`、`make_local_tool_wrapper`（interrupt + `Command(resume=...)`）续流。
> 前置：Phase 2 云端改动（`docs/整体架构计划/Phase2改动计划.md`）已完成--`require_approval` 按权限置位（`permissions != "read"` -> `true`）、`cancelled` 审批拒绝续流处理。
> 前置：Phase 3 云端改动（`docs/整体架构计划/Phase3改动计划.md`）已完成--Agent 系统提示增强（代码智能工具使用指引）、大结果裁剪策略（日志记录）。
>
> 本文描述云端为支持「Phase 4 终端与 Git 集成」必须做的改动。
> **核心结论：Phase 1-3 已建立完整协议与工具包装机制，Phase 4 云端改动很小**--主要是「Agent 系统提示增强（终端/Git 工具使用指引）」与「终端大输出裁剪策略」。
> 新增本地工具（`terminal.exec` / `git.*`）**无需云端逐个适配**：它们经 `local_tools` 上报后由 `make_local_tool_wrapper` 统一包装，云端自动可见。

---

## 一、背景与目标

Phase 1-3 让 Agent 能读写文件、精准编辑、查诊断/符号/引用--但只能"看"代码不能"跑"代码，也不能操作版本控制。Phase 4 本地侧引入**终端执行工具**（`terminal.exec`，受控 shell + 命令白名单/危险拦截 + 审批）与 **Git 工具集**（`git.status` / `git.diff` / `git.commit` / `git.branch` / `git.stash`，基于 `simple-git`）。

云端在 Phase 4 需要：

1. **Agent 系统提示增强**：指导 LLM 何时使用终端/Git 工具（如「修改代码后用 `terminal.exec` 跑测试验证」「提交前用 `git.status`/`git.diff` 审查变更」「测试失败时解析 stderr 定位问题」），否则 LLM 不知道这些工具的存在或用法。
2. **终端大输出裁剪策略**：终端 stdout/stderr 可能很大（如全量测试输出数千行），虽本地已做基础截断（默认 10000 字符保留尾部），云端应确保大结果不撑爆 LLM 上下文窗口。
3. **工具权限验证**：`terminal.exec` 为 `execute` 权限、`git.commit`/`git.branch`/`git.stash` 为 `write` 权限，经 Phase 2 的 `_require_approval(permissions)` 逻辑自动派生 `require_approval: true`。**无需额外协议改动**。

> **重要**：与 Phase 2/3 一样，新工具经 `local_tools` 自动上报，`make_local_tool_wrapper` 自动包装。`terminal.exec` 的 `handlesOwnApproval` 是本地实现细节（本地在 `execute` 内先做 ShellWhitelist 危险拦截再按需弹审批），**云端无感知**--云端只看到 `tool_call` 事件与 `/tool_result` 回传，与 Phase 1 协议一致。

---

## 二、现状（Phase 1-3 已建立的契约，无需重复实现）

| 关注点                    | 文件                                               | Phase 1-3 现状（Phase 4 复用）                                                                                                                                                  |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_call` 事件        | `app/api/agent/util/stream_protocol.py`          | 已支持`{call_id, tool, args, site, require_approval}` 对象 data。`require_approval` 按 `permissions` 派生（read=false，execute/write=true）。                             |
| `/tool_result` 端点     | `app/api/agent/invoke/views.py` + `service.py` | 已实现，返回 SSE 续流。请求体含`status`/`result`/`error`/`metadata`。                                                                                                   |
| 本地工具包装              | `app/api/agent/tool/impl/local_tool_wrapper.py`  | `make_local_tool(schema)` 把任意 `LocalToolSchema` 包装为 interrupt 型 LangChain 工具。**新工具自动适配，无需逐个改**。                                               |
| 会话级本地工具            | `app/api/agent/invoke/service.py`                | `create_session(agent_id, local_tools)` 已把 `local_tools` 与 session 绑定，装配时合并进 `create_agent(tools=...)`。                                                      |
| 续流                      | `service.py` `resume_stream`                   | 以`session_id` 为 `thread_id`，`Command(resume=ToolMessage(...))` 续流，复用 checkpointer 历史。                                                                          |
| schema                    | `app/api/agent/invoke/schemas.py`                | `LocalToolSchema` 已含 `permissions` 字段；`InvokeToolResultIn` 已含 `status`/`metadata`。                                                                            |
| `require_approval` 派生 | `local_tool_wrapper.py`                          | `_require_approval(permissions)` -> `permissions != "read"`。`terminal.exec`(execute) -> `true`；`git.commit`(write) -> `true`；`git.status`(read) -> `false`。 |
| 系统提示增强              | Agent 装配提示模板                                 | Phase 3 已为`code.*` 工具动态拼接代码智能指引。Phase 4 扩展为 `terminal.*`/`git.*` 工具指引。                                                                             |

**结论**：Phase 4 不新增端点、不改协议信封、不改 schema 字段、不改包装器逻辑。改动集中在「Agent 系统提示」与「结果裁剪策略」。

---

## 三、协议契约（与本地 spec 对齐）

### 3.1 `tool_call` 事件 -- 新工具自动透传

云端识别到 LLM 请求本地终端/Git 工具时，`tool_call` 事件格式不变：

```json
// terminal.exec（execute 权限，require_approval=true）
{"type":"tool_call","data":{
  "call_id":"c7","tool":"terminal.exec","args":{"command":"npm test"},
  "site":"local","require_approval":true
}}

// git.status（read 权限，require_approval=false）
{"type":"tool_call","data":{
  "call_id":"c8","tool":"git.status","args":{},
  "site":"local","require_approval":false
}}

// git.commit（write 权限，require_approval=true）
{"type":"tool_call","data":{
  "call_id":"c9","tool":"git.commit","args":{"message":"fix: correct off-by-one"},
  "site":"local","require_approval":true
}}
```

- `require_approval` 由 `_require_approval(permissions)` 派生：`terminal.exec`(execute)->`true`，`git.status`/`git.diff`(read)->`false`，`git.commit`/`git.branch`/`git.stash`(write)->`true`。
- `args` 由 LLM 生成，经 `make_local_tool_wrapper` 的 `args_schema` 校验后透传。
- `tool_call` 后仍**自然结束当前 SSE 流**（与 Phase 1-3 一致），等 `/tool_result` 续流。

> **注意**：`terminal.exec` 的 `require_approval=true` 仅为信息性（云端派生）。本地 `terminal.exec` 用 `handlesOwnApproval` 自行编排「ShellWhitelist 危险拦截 -> 按需弹审批 -> 执行」，**不依赖云端 `require_approval` 标志**（本地安全边界权威，防御纵深）。

### 3.2 `/tool_result` -- 结构化 JSON 结果

本地工具执行后回传结构化 JSON 字符串作为 `result`：

```json
// terminal.exec 成功
{"session_id":"...","call_id":"c7","status":"success",
 "result":"{\"stdout\":\"\\n  ✓ test auth (5ms)\\n  ✓ test user (3ms)\\n\\n2 passing\",\"stderr\":\"\",\"exitCode\":0,\"truncated\":false}",
 "metadata":{"exitCode":0,"duration_ms":1234}}

// terminal.exec 危险命令拦截（cancelled）
{"session_id":"...","call_id":"c7","status":"cancelled","error":"危险命令已被拦截: rm -rf"}

// terminal.exec 审批拒绝（cancelled）
{"session_id":"...","call_id":"c7","status":"cancelled","error":"用户拒绝执行"}

// terminal.exec 超时（error）
{"session_id":"...","call_id":"c7","status":"error","error":"命令执行超时（300s）"}

// git.status
{"session_id":"...","call_id":"c8","status":"success",
 "result":"{\"currentBranch\":\"main\",\"staged\":[],\"unstaged\":[],\"untracked\":[],\"truncated\":false}",
 "metadata":{"duration_ms":45}}

// git.commit
{"session_id":"...","call_id":"c9","status":"success",
 "result":"已提交: a1b2c3d",
 "metadata":{"sha":"a1b2c3d","duration_ms":120}}
```

云端将 `result`（JSON 字符串）注入为 `ToolMessage(content=result, tool_call_id=call_id)`，Agent 据此推理。

- `metadata` Phase 1-3 已定义（`affected_files`/`diff`/`duration_ms`）。Phase 4 终端工具新增 `metadata.exitCode`（exitCode 非 0 仍为 success，由 LLM 据 exitCode 判断是否失败）。git.commit 新增 `metadata.sha`。**不改变 metadata 信封结构，仅新增可选字段**。
- **无新增 metadata 字段冲突**--`exitCode`/`sha` 为 Phase 4 工具特有，其他工具不填充。

### 3.3 `local_tools` 上报 -- 新工具自动包含

会话创建时，本地 `ToolRegistry.list()` 自动包含新工具 schema：

```json
{"agent_id":"a1","local_tools":[
  {"name":"fs.read_file","description":"...","parameters":{...},"permissions":"read","site":"local"},
  {"name":"code.edit","description":"...","parameters":{...},"permissions":"write","site":"local"},
  {"name":"code.get_diagnostics","description":"...","parameters":{...},"permissions":"read","site":"local"},
  {"name":"terminal.exec","description":"执行 shell 命令...","parameters":{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeoutMs":{"type":"number"}},"required":["command"]},"permissions":"execute","site":"local"},
  {"name":"git.status","description":"查看工作区状态...","parameters":{"type":"object","properties":{}},"permissions":"read","site":"local"},
  {"name":"git.diff","description":"查看 diff...","parameters":{"type":"object","properties":{"mode":{"type":"string","enum":["unstaged","staged","ref"]},"base":{"type":"string"}}},"permissions":"read","site":"local"},
  {"name":"git.commit","description":"提交变更...","parameters":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]},"permissions":"write","site":"local"},
  {"name":"git.branch","description":"分支管理...","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["list","create","checkout"]},"name":{"type":"string"}}},"permissions":"write","site":"local"},
  {"name":"git.stash","description":"stash 操作...","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["push","pop","list"]},"message":{"type":"string"}}},"permissions":"write","site":"local"}
]}
```

云端 `make_local_tool_wrapper` 自动包装每个 schema，合并进 `create_agent(tools=...)`。**无需逐个适配**。

---

## 四、改动清单（按文件）

### 4.1 Agent 系统提示增强（核心改动）

**文件**：`app/api/agent/` 下 Agent 装配相关的提示模板（Phase 3 已为 `code.*` 动态拼接，扩展为 `terminal.*`/`git.*`）。

**做什么**：

在 Agent 系统提示中增加**终端与 Git 工具使用指引**（检测 `local_tools` 中是否包含 `terminal.*`/`git.*` 工具，若有则动态拼接）：

```
## 终端执行工具使用指引

你拥有 `terminal.exec` 工具，可在用户工作区执行 shell 命令。请在合适场景主动使用：

- `terminal.exec`：执行 shell 命令（捕获 stdout/stderr/exitCode）。
  - 修改代码后，用此工具运行测试/构建/lint 验证（形成"编辑-运行-验证"闭环）。
  - 查看项目结构、依赖版本、运行脚本。
  - 参数 `command` 为要执行的命令（必填），`cwd` 可选（相对工作区根的子目录），`timeoutMs` 可选。
  - **危险命令（rm -rf、重定向、管道、命令分隔等）会被自动拦截**；白名单命令（npm test 等）自动放行；其余命令需用户审批。
  - 测试失败时，解析 stdout/stderr 中的错误信息定位问题，再用 code.edit 修复，然后重新运行验证。

使用建议：
1. 验证流程：code.edit 修改 -> terminal.exec 运行测试 -> 解析结果（exitCode 非 0 表示失败）-> 必要时修复 -> 重跑
2. 探索流程：terminal.exec 运行 `ls`/`cat package.json` 了解项目 -> read_file 精读
3. 避免交互式命令（如需 stdin 输入的命令会超时）；优先用非交互标志（如 `npm test` 而非交互式 REPL）

## Git 工具使用指引

你拥有以下 Git 工具，请在版本控制场景主动使用：

- `git.status`：查看工作区状态（当前分支、已暂存/未暂存/未跟踪文件）。
  - 修改代码后、提交前，用此工具审查变更范围。
- `git.diff`：查看未提交的 diff（支持 unstaged/staged/ref 三模式）。
  - 提交前审查具体改动；定位"我改了什么"。
- `git.commit`：提交已暂存的变更（需用户审批；禁止 --no-verify/--amend）。
  - 提交前先 `git.status` + `git.diff` 审查，确认无误后 `git add`（通过 terminal.exec）再 commit。
- `git.branch`：分支管理（list/create/checkout，需用户审批）。
  - 开始新功能前创建分支；查看当前分支也可用 `git.status`。
- `git.stash`：暂存/恢复当前更改（push/pop/list，需用户审批）。
  - 切换分支前若有未提交更改，可 stash 暂存。

使用建议：
1. 提交流程：git.status 审查 -> git.diff 看具体改动 -> terminal.exec `git add <file>` 暂存 -> git.commit 提交
2. 分支流程：git.branch create 新分支 -> 修改代码 -> 提交 -> 必要时 git.branch checkout 回主分支
```

**为什么**：LLM 不知道这些工具的存在（工具 schema 有 description 但 LLM 可能不会主动使用），系统提示层指引成本最低、效果最显著。Phase 3 已验证此模式对 `code.*` 工具有效。

**实现方式**：

- 方案 A（推荐，与 Phase 3 一致）：在 Agent 装配时，检测 `local_tools` 中是否包含 `terminal.*` 或 `git.*` 工具，若有则动态拼接对应指引到系统提示。
- 方案 B：无条件拼接（即使没有对应工具也拼）-- 否决（无关提示干扰 LLM）。

### 4.2 终端大输出裁剪策略（可选但推荐）

**文件**：`app/api/agent/util/stream_protocol.py` 或 `app/api/agent/invoke/service.py`（续流注入 ToolMessage 前）。

**做什么**：

本地已对终端输出做基础截断（stdout/stderr 各 10000 字符保留尾部），但云端在注入 `ToolMessage` 前可做**二次裁剪**，防止极端情况（多轮终端调用累积、LLM 上下文窗口逼近上限）：

- 检测 `ToolMessage.content` 长度，超过阈值（如 20K 字符）时：
  - 对 JSON 结果做结构化截断：保留 stderr 全部 + stdout 尾部（错误信息优先）+ 附截断标记
  - 或附加提示：「终端输出已截断，如需完整输出请缩小查询范围或分页运行」
- **Phase 4 建议最小实现**：仅做长度检测与日志记录（`logger.info`），不实际裁剪（本地截断已足够）。Phase 6 统一裁剪层再做。

**为什么**：防御纵深。本地截断是工具级的（单次 10000 字符），云端裁剪是会话级的（考虑 LLM 上下文窗口总量，多轮终端调用累积）。

**备选**：完全信任本地截断 -- 可接受（单次 10000 字符，约 2-3K token），但多轮累积（如 5 次终端调用 = 50K 字符 = ~12K token）可能逼近上下文窗口。

**Phase 4 决策**：**仅日志记录，不实际裁剪**。本地截断 + 工具结果 JSON 结构紧凑，实际不会撑爆。Phase 6 做统一裁剪层。

### 4.3 `local_tool_wrapper.py` -- 无代码改动（确认即可）

**文件**：`app/api/agent/tool/impl/local_tool_wrapper.py`

**做什么**：

确认以下行为对 Phase 4 新工具正常：

- `_require_approval(schema.permissions)`：
  - `terminal.exec`(execute) -> `true` ✅
  - `git.status`/`git.diff`(read) -> `false` ✅
  - `git.commit`/`git.branch`/`git.stash`(write) -> `true` ✅
- `interrupt` payload 含正确的 `require_approval` 值。✅（Phase 2 逻辑）
- 工具 `description` 透传给 LLM（Phase 1 已透传）。Phase 4 本地侧在 `description` 中写清楚使用场景，确认云端不截断/修改 description。✅
- 工具拒绝（`cancelled`）处理：
  - `terminal.exec` 危险命令拦截 -> 本地回传 `cancelled`（Phase 2 已处理 `cancelled` 注入 ToolMessage）✅
  - `terminal.exec`/`git.*` 审批拒绝 -> 本地回传 `cancelled` ✅
  - `terminal.exec` 超时 -> 本地回传 `error`（Phase 1 已处理 `error` 注入 ToolMessage）✅
- `metadata.exitCode`/`metadata.sha`：Phase 1 已定义 `metadata` 为 `dict | None`，新增字段不影响解析。✅

**结论**：无代码改动。

### 4.4 工具清单上报验证（无代码改动）

**文件**：无（验证项）。

**做什么**：

验证 Phase 1 已实现的 `local_tools` 上报机制对 Phase 4 新工具正常工作：

1. 本地 `ToolRegistry.list()` 返回的 schema 数组包含 6 个新工具（`terminal.exec` + 5 个 `git.*`）。
2. `create_session(agent_id, local_tools)` 正确接收并存储。
3. `make_local_tool_wrapper` 对每个新工具生成有效的 LangChain `BaseTool`。
4. `create_agent(tools=...)` 合并后 LLM 在工具列表中看到新工具。
5. LLM 调用新工具时，`interrupt` payload 正确生成 `{call_id, tool, args, site, require_approval}`。
6. 省略 `local_tools` 时向后兼容（纯聊天不回归）。

**风险**：Low -- Phase 2/3 已验证 `execute`/`write`/`read` 各权限工具的自动包装，`terminal.exec`/`git.*` 参数 schema 更简单。

---

## 五、终端/Git 工具的多轮调用模式

Phase 4 的典型场景涉及多轮工具调用链（每轮一个 `tool_call` + `/tool_result` 续流）：

```
场景："跑一下测试，如果失败就修复"

轮 1: SSE tool_call: terminal.exec {command: "npm test"}
     -> /tool_result: {status:"success", result:"{stdout:'...2 failing...', stderr:'AssertionError...', exitCode:1}", metadata:{exitCode:1}}
轮 2: SSE tool_call: code.get_diagnostics {file:"src/auth.ts"}
     -> /tool_result: {diagnostics:[{file:"src/auth.ts",line:25,severity:"error",message:"..."}]}
轮 3: SSE tool_call: code.edit {path:"src/auth.ts", oldString:"...", newString:"..."}
     -> /tool_result: {status:"success", metadata:{diff:"...", affected_files:["src/auth.ts"]}}
轮 4: SSE tool_call: terminal.exec {command: "npm test"}
     -> /tool_result: {status:"success", result:"{stdout:'...2 passing...', exitCode:0}", metadata:{exitCode:0}}
轮 5: SSE content: "测试已修复并全部通过。"
     -> SSE end
```

```
场景："查看当前变更并提交"

轮 1: SSE tool_call: git.status {}
     -> /tool_result: {status:"success", result:"{currentBranch:'feature/x', staged:['src/a.ts'], unstaged:[], untracked:[]}"}
轮 2: SSE tool_call: git.diff {mode:"staged"}
     -> /tool_result: {status:"success", result:"diff --git a/src/a.ts ..."}
轮 3: SSE tool_call: git.commit {message:"feat: add x"}
     -> /tool_result: {status:"success", result:"已提交: a1b2c3d", metadata:{sha:"a1b2c3d"}}
轮 4: SSE content: "已提交变更到 feature/x 分支。"
     -> SSE end
```

**云端要点**：

- 每轮 `tool_call` 后 SSE 流自然 end，`/tool_result` 续流开新 SSE 流（Phase 1 机制）。
- checkpointer 以 `thread_id=session_id` 保留完整历史（AIMessage 含 tool_calls + 对应 ToolMessage），Agent 据此跨轮推理。
- **无新增续流逻辑**--Phase 1 已支持多轮 tool_call 闭环，Phase 2/3 已验证 write/read 工具链路，Phase 4 仅工具类型不同（execute 权限的终端工具）。

---

## 六、与本地契约的一致性核对

| 项                                 | 本地（Phase 4）                                                          | 云端（本计划）                                                           | 一致                       |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------- |
| `tool_call` 格式                 | 解析`{call_id, tool, args, site, require_approval}`                    | 透传（Phase 1-3 机制）                                                   | ✅                         |
| `require_approval`               | 本地`terminal.exec` handlesOwnApproval 自行编排，不依赖云端标志        | 按`permissions` 置位（execute/write=true，read=false）（Phase 2 逻辑） | ✅（云端信息性，本地权威） |
| `/tool_result` 响应              | SSE 续流（Phase 1 机制）                                                 | 同                                                                       | ✅                         |
| 结果格式                           | JSON 字符串（`{stdout,stderr,exitCode}` / `{currentBranch,...}` 等） | 注入`ToolMessage(content=result)`                                      | ✅                         |
| `metadata`                       | 终端新增`exitCode`，git.commit 新增 `sha`                            | Phase 1 已定义`metadata: dict`，新增字段不影响解析                     | ✅                         |
| `cancelled`（危险拦截/审批拒绝） | 本地回传`cancelled`                                                    | 注入 ToolMessage，Agent 调整不重试（Phase 2 逻辑）                       | ✅                         |
| 新工具 schema                      | 经`local_tools` 上报（Phase 1 机制）                                   | `make_local_tool_wrapper` 自动包装                                     | ✅（无需逐个适配）         |
| 命名空间                           | `terminal.`/`git.`                                                   | 透传                                                                     | ✅                         |
| 系统提示                           | 本地不参与（云端 Agent 提示）                                            | 云端增强（4.1）                                                          | ✅                         |
| 续流模式                           | 流中断 + HTTP 回传 + 内部续流（Phase 1）                                 | 同                                                                       | ✅                         |
| 安全边界                           | ShellWhitelist 危险拦截 + 审批（本地强制）                               | 云端不参与（本地安全边界）                                               | ✅                         |

---

## 七、测试（云端 `tests/api/agent/`）

1. `test_system_prompt_terminal_git.py`：`create_session` 带 `terminal.*`/`git.*` 工具时，Agent 系统提示含终端/Git 指引；不带时不含（方案 A 动态拼接）。
2. `test_local_tool_wrapper_terminal_git.py`：`make_local_tool` 对 `terminal.exec`(execute)/`git.status`(read)/`git.commit`(write) schema 产出有效 `BaseTool`；`require_approval` 分别为 `true`/`false`/`true`；`interrupt` payload 含正确 `tool`/`args`/`site`。
3. `test_invoke_tool_result_terminal.py`：`/tool_result` 传 `terminal.exec` 的 JSON 结果（含 `exitCode`）-> 续流注入 `ToolMessage`，Agent 据此推理（如「exitCode=1，测试失败，需修复」）。
4. `test_invoke_tool_result_terminal_cancelled.py`：`/tool_result` 传 `terminal.exec` 危险命令拦截的 `cancelled` -> 续流注入 ToolMessage（content 含「拦截」语义），Agent 不重试相同命令（改换策略）。
5. `test_invoke_tool_result_git.py`：`/tool_result` 传 `git.status`/`git.commit` 的 JSON 结果 -> 续流注入 `ToolMessage`，Agent 据此推理（如「有 3 个 staged 文件，可以提交」）。
6. `test_terminal_git_multi_round.py`：多轮 tool_call 闭环--`terminal.exec`(npm test 失败) -> `code.edit`(修复) -> `terminal.exec`(npm test 通过) -> `git.status` -> `git.commit`，每轮 `/tool_result` 续流，checkpointer 历史完整。
7. `test_tool_result_large_terminal_output.py`（可选）：`/tool_result` 传超大终端输出（模拟 10000 字符 stdout）-> 续流正常，不超 LLM 上下文限制（验证 4.2 裁剪策略）。
8. 回归 Phase 1-3 用例：`test_session_local_tools.py`（新工具自动合并）、`test_resume_continuation.py`（多轮 tool_call 闭环含 terminal/git 工具）、`test_invoke_tool_result_cancelled.py`（Phase 2 审批拒绝不回归）、`test_system_prompt_code_intelligence.py`（Phase 3 代码智能指引不回归）。

---

## 八、风险与开放问题

- **LLM 生成危险命令**（Medium）-> 本地 ShellWhitelist 硬拦截 + 审批双闸；云端系统提示指引「避免危险命令」。即使 LLM 生成 `rm -rf`，本地拦截返回 `cancelled`，Agent 据此改换策略。云端无额外防护（本地是安全边界）。
- **LLM 不主动使用终端/Git 工具**（Medium）-> 系统提示增强（4.1）指导 LLM 何时用；工具 `description` 写清楚使用场景。联调时观察 LLM 是否在「修改代码后主动跑测试」「提交前主动审查变更」；若不主动，考虑在 Agent 的 ReAct 提示中增加「修改代码后必须运行测试验证」的硬约束。
- **终端输出撑爆上下文**（Low）-> 本地已截断（10000 字符保留尾部）；云端 4.2 仅日志记录。Phase 6 统一裁剪层。联调时监控多轮终端调用的累积 token。
- **`terminal.exec` 的 `handlesOwnApproval` 与云端 `require_approval` 语义**（Low）-> 云端发 `require_approval=true`（因 execute 权限），但本地 `handlesOwnApproval` 自行编排不依赖此值。语义自洽：云端标志为信息性（可观测），本地权威。联调时确认云端不因 `require_approval=true` 而做额外处理（如等待审批回调--云端不参与本地审批）。
- **git.commit 审批与本地 `handlesOwnApproval`**（Low）-> `git.commit` 非 `handlesOwnApproval`（走路由层统一审批），与 `terminal.exec` 不同。云端无感知差异（都是 `tool_call` -> `/tool_result`）。
- **批量 `tool_call_batch`**（后续阶段）-> Phase 4 仍每轮至多一个本地 tool_call。终端 + git 场景可能需要并行（如同时查 status 和 diff），批量并行留后续。
- **交互式命令超时**（Medium）-> 本地超时 5min + kill 兜底；系统提示指引「避免交互式命令」。云端注入 `error`(超时) ToolMessage，Agent 据此改用非交互标志或放弃。

---

**文档版本**：v1.0 · **日期**：2026-08-03 · **配套**：本地 OpenSpec change `phase4-terminal-git-integration` · **前置**：`docs/整体架构计划/Phase1改动计划.md` + `Phase2改动计划.md` + `Phase3改动计划.md`
