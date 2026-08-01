## Why

云效 Agent 插件目前只是一个「基础对话面板」——用户发消息、云端流式回复，云端 Agent 无法触及用户本地工作区（读文件、改代码、跑命令）。要演进为类 Claude Code 的智能助手，必须让云端 Agent 的决策能落地到本地执行。Phase 1 是这条路径上的**最小可运行闭环**：在不破坏现有聊天流程的前提下，接入「本地工具调用」协议，跑通一个只读本地工具（`fs.read_file`），验证「云端决策 → SSE 下发 `tool_call` → 本地执行 → HTTP 回传 `tool_result` → 云端续流」的端到端链路。这一阶段只做协议层与基础设施，不引入写操作、审批、终端等高风险能力，把安全与正确性的根基先打牢。

## What Changes

- 新增**共享类型契约**（`src/core/types.ts`）：`ToolCall` / `ToolResult` / `ToolSchema` / `ExecutionSite`，作为后续所有模块的依赖。
- 新增**SSE 事件处理器**（`src/protocol/sseHandler.ts`）：从 `aiClient.ts` 抽出 SSE 解析逻辑，新增 `tool_call` / `plan` / `progress` 事件分发，保留 `content` / `thought` / `tool_start` / `tool_end`，处理半包缓冲。
- 新增**工具注册表**（`src/core/toolRegistry.ts`）：`register(schema, executor)` / `lookup(name)` / `list()`，并向云端提供本地工具 schema。
- 新增**路径安全守卫**（`src/tools/fs/pathGuard.ts`）——**CRITICAL**：工作区根解析、`..` 越界检测、符号链接处理、绝对路径规范化（Windows/Unix）、敏感文件检测。所有文件工具的安全前提。
- 新增**首个本地工具** `fs.read_file`（`src/tools/fs/readFile.ts`）：路径解析（经 pathGuard）、大小限制（默认 1MB）、二进制检测，继承 `BaseTool` 基类。先做只读工具，无需审批、风险最低。
- 新增**会话状态机**（`src/core/sessionManager.ts`）：维护 `sessionId → {pendingToolCalls, history, abortController}`，处理 SSE 流的多次中断与续流，管理工具调用 pending/running/success/error 状态，实现超时与取消。
- 新增**工具结果回传协议**（`src/protocol/toolCallProtocol.ts`）：封装 `POST /api/agent/invoke/tool_result`，含指数退避重试（最多 3 次）、超时（默认 30s）、错误映射。
- 扩展**AIClient**（`src/aiClient.ts`）：新增 `submitToolResult()`；`streamMessage` 回调扩展 `onToolCall` / `onPlan` / `onProgress`，保持现有回调不变。
- 新增**工具基类**（`src/tools/baseTool.ts`）：定义 `execute` / `validate` / `permission` 契约。
- **依赖云端协议扩展**（不在本仓库实现，见 `docs/整体架构计划/Phase1改动计划.md`）：云端需新增 `tool_call` SSE 事件、`/api/agent/invoke/tool_result` 端点、会话创建时接收 `local_tools`、以及续流逻辑。本地据此对接。

## Capabilities

### New Capabilities
- `tool-call-protocol`: 本地工具调用的线协议契约——`tool_call` SSE 事件格式、`/tool_result` HTTP 回传接口、续流（流中断 + HTTP 回传 + 内部续流）模型、会话创建时上报本地工具 schema。跨本地与云端双方。
- `local-tool-registry`: 本地工具注册表与路由——工具 schema/权限元数据声明、注册/查找/列举、按 `site` 分发到本地/云端执行器、向云端上报工具清单。
- `path-guard`: 工作区路径安全守卫——工作区根解析、路径遍历（`..`）拦截、符号链接处理、Windows/Unix 路径规范化、敏感文件检测。安全关键，所有文件工具的前置校验。
- `file-tools`: 本地文件工具集——以 `fs.read_file` 为首个实现，定义 `BaseTool` 契约（execute/validate/permission）、大小限制、二进制检测。Phase 2 文件工具的基座。
- `session-orchestration`: 会话状态机——单次用户输入触发多轮 SSE 流（每轮可能含工具调用）的协调、工具调用生命周期（pending/running/success/error）、续流、超时与取消。

### Modified Capabilities
<!-- 本仓库 openspec/specs/ 当前为空，无既有能力被修改。 -->

## Impact

- **新增代码**：`src/core/`（types、toolRegistry、sessionManager、eventBus、errors）、`src/protocol/`（sseHandler、toolCallProtocol、messageProtocol）、`src/tools/`（baseTool、fs/readFile、fs/pathGuard）。目录结构按 `docs/04-架构演进规划.md` 第四节落地。
- **改动代码**：`src/aiClient.ts`（抽出 SSE 解析、扩展回调与 `submitToolResult`）、`src/chatPanel.ts`（接入 sessionManager 与工具调用卡片的最小展示）、`src/extension.ts`（装配新模块）。
- **依赖**：无需新增 npm 依赖（Phase 1 全部用 Node 内置 + VSCode API）；`package.json` 已 override 的 `diff` 包留待 Phase 2。
- **云端依赖（外部）**：云端 Agent 仓库（`D:\python_project\ai_training`）需同步实现协议扩展，详见 `docs/整体架构计划/Phase1改动计划.md`。Phase 1 在云端就绪前可用 mock 云端先行跑通本地链路。
- **安全**：`path-guard` 为 CRITICAL，单测必须覆盖 `../../../etc/passwd`、工作区外绝对路径、符号链接、Windows/Unix 路径差异等越界场景。
- **非目标**：不实现写文件 / 编辑 / diff / 终端 / git / 审批网关 / 代码索引 / UI 组件化重构——这些属 Phase 2+。
