## Why

Phase 1 跑通了只读工具 `fs.read_file` 的端到端闭环，但云端 Agent 仍无法**修改**用户工作区--不能建文件、改代码、搜代码、删/移文件。这意味着 Agent 只能"看"不能"动手"，离类 Claude Code 的智能助手还有关键一跳。Phase 2 在 Phase 1 的协议与基础设施之上，补齐**核心文件操作工具集**与**审批网关**：让 Agent 能写、列、搜、删、移文件，并能做 Claude Code 风格的"精准编辑"（`code.edit` + diff 预览），同时所有写操作经用户审批后方可执行。这一阶段把"只读探查"升级为"受控读写"，是后续代码智能（Phase 3）与终端/Git（Phase 4）的前置依赖。

## What Changes

- 新增**审批网关**（`src/core/approvalGateway.ts`）：写/删除/移动/编辑等变更操作执行前必须经用户确认。提供三选项--"本次会话允许"（仅当前 session 记忆）、"始终允许"（持久化到 `yunxiaoAgent.alwaysAllowTools` 配置）、"拒绝"（回传 `cancelled`）。只读工具（`read` 权限）自动放行。Phase 2 用 `vscode.window.showWarningMessage` 三按钮实现，精细 Webview 审批对话框留待 Phase 5。
- **工具路由集成审批**（`src/core/toolRouter.ts`）：路由层在 `execute` 前按 `tool.permission` 判定--`write`/`execute`/`destructive` 须先经审批网关，拒绝则直接返回 `cancelled` 结果，不执行。`read` 工具直通。
- 新增**写文件工具** `fs.write_file`（`src/tools/fs/writeFile.ts`）：经 pathGuard 解析、自动创建父目录、原子写入（临时文件 + rename）、覆盖检测、集成审批。
- 新增**列目录工具** `fs.list_dir`（`src/tools/fs/listDir.ts`）：返回树状结构（含文件大小、修改时间），支持 `.gitignore` 规则过滤、按类型（目录/文件）过滤。
- 新增**文件搜索工具** `fs.search_files`（`src/tools/fs/searchFiles.ts`）：优先包装 `rg`（ripgrep）子进程，提供 glob 与正则两种模式，返回匹配上下文（前 2 后 2 行）；`rg` 不存在时回退 Node 原生搜索。
- 新增**删除/移动工具** `fs.delete_file`（`src/tools/fs/deleteFile.ts`）、`fs.move_file`（`src/tools/fs/moveFile.ts`）：删除优先移入回收站（`vscode.workspace.fs.delete` 的 `useTrash`）而非永久删除；移动含覆盖检测；均集成审批。
- 新增**Diff 引擎**（`src/tools/diff/diffEngine.ts`）：unified diff 解析、patch 应用（含上下文行匹配、空白容忍）、三向合并冲突检测；引入 `diff` npm 包（已在 `package.json` overrides 中）。
- 新增**代码编辑工具** `code.edit`（`src/tools/code/editFile.ts`）：支持两种模式--`{path, oldString, newString}` 精确替换、`{path, patch}` 应用 unified diff。生成 diff，经 diff 可视化（`vscode.diff` 命令）预览，用户确认后应用；含冲突检测（应用前重新读取文件并比对，防止并发修改覆盖）。
- 新增**Diff 可视化**（`src/tools/diff/diffViewer.ts`）：封装 `vscode.commands.executeCommand('vscode.diff', original, modified, title)`，提供"应用/回滚"动作。Phase 2 用 VSCode 内置 diff 编辑器，inline webview diff 预览留 Phase 5。
- **装配**（`src/extension.ts`）：实例化 `ApprovalGateway` 并注入 `ToolRouter`；注册全部新工具到 `ToolRegistry`；新增配置项 `yunxiaoAgent.alwaysAllowTools`（数组，默认空）。
- **依赖云端协议扩展**（不在本仓库实现，见 `docs/整体架构计划/Phase2改动计划.md`）：云端须按本地工具 `permissions` 对写/破坏性工具在 `tool_call` 事件中置 `require_approval: true`（Phase 1 始终发 `false`）；接收 `cancelled` 审批拒绝结果并据此调整策略（注入 `ToolMessage`，不重试同一工具）。`/tool_result` 的 `metadata.diff` / `metadata.affected_files` 字段 Phase 1 已定义，Phase 2 由 `code.edit` 填充。

## Capabilities

### New Capabilities
- `approval-gateway`: 写/删除/移动/编辑等变更操作执行前的用户审批闸门--三选项（本次会话允许 / 始终允许 / 拒绝）、只读工具自动放行、"始终允许"持久化到配置、会话级允许记忆。
- `diff-engine`: unified diff 解析、patch 应用（上下文匹配、空白容忍）、三向合并冲突检测。`code.edit` 的底层依赖，基于 `diff` npm 包，纯函数可单测。
- `code-edit`: `code.edit` 工具--`{path, oldString, newString}` 精确替换与 `{path, patch}` unified diff 两种模式、diff 预览（VSCode diff 编辑器）、冲突检测（应用前重读比对）、集成审批网关。

### Modified Capabilities
- `file-tools`: 在现有 `fs.read_file` 基础上扩展文件工具集--新增 `fs.write_file`（原子写入、覆盖检测、审批）、`fs.list_dir`（树状、.gitignore、过滤）、`fs.search_files`（ripgrep 包装、Node 回退、上下文行）、`fs.delete_file`（回收站优先、审批）、`fs.move_file`（覆盖检测、审批）。所有新工具经 pathGuard 解析路径。
- `local-tool-registry`: 工具路由层集成审批网关--`write`/`execute`/`destructive` 权限工具执行前须经 `ApprovalGateway` 确认，拒绝返回 `cancelled`；`read` 工具直通。

## Impact

- **新增代码**：`src/core/approvalGateway.ts`、`src/tools/fs/{writeFile,listDir,searchFiles,deleteFile,moveFile}.ts`、`src/tools/code/editFile.ts`、`src/tools/diff/{diffEngine,diffViewer}.ts` 及对应单测。
- **改动代码**：`src/core/toolRouter.ts`（注入 `ApprovalGateway`、执行前审批判定）、`src/extension.ts`（装配网关 + 注册新工具）、`src/chatPanel.ts`（转发审批请求/结果到 Webview 的最小展示）、`package.json`（新增 `yunxiaoAgent.alwaysAllowTools` 配置 + `diff` 依赖正式化）。
- **依赖**：正式引入 `diff` npm 包（`^8.0.4`，已在 `package.json` overrides）；ripgrep 依赖系统 `rg`，缺失时回退 Node 原生搜索，无硬依赖。
- **云端依赖（外部）**：云端 Agent 仓库（`D:\python_project\ai_training`）须实现 `require_approval` 路由（按本地工具 permissions 置位）与审批拒绝（`cancelled`）的续流处理，详见 `docs/整体架构计划/Phase2改动计划.md`。本地在云端就绪前可用 mock 云端先行跑通。
- **安全**：所有写/删除/移动操作经审批网关 + pathGuard 双重校验；删除优先回收站；`code.edit` 应用前重读比对防并发覆盖。
- **非目标**：代码智能（诊断/符号/引用/索引，Phase 3）、终端执行/Git（Phase 4）、Webview 组件化重构与精细审批/diff 卡片（Phase 5）、批量并行 `tool_call_batch`。
