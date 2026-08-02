## Why

Phase 1 跑通了只读工具 `fs.read_file` 的混合编排闭环，Phase 2 补齐了核心文件操作工具集（写/列/搜/删/移/编辑）与审批网关。但 Agent 目前只能把代码当**文本**处理--不能查 lint/type 诊断、不能按符号名定位、不能找引用、不能跳定义，更没有代码索引支撑大工作区的上下文检索。这意味着 Agent 无法做真正的"代码理解与重构"：改名后不知道是否引入错误，找不到所有调用点，定位不了函数定义。Phase 3 让 Agent 通过 VSCode Language API 获得类 IDE 的代码智能能力，并建立本地代码索引保障大工作区检索性能，是从"文本操作"升级到"代码理解"的关键一跃。

## What Changes

- 新增**诊断查询工具** `code.get_diagnostics`（`src/tools/code/getDiagnostics.ts`）：基于 `vscode.languages.getDiagnostics()`，返回当前所有 lint/type 错误（含位置、错误信息、严重级别），支持按文件过滤。Agent 修改代码后能自查错误，形成"编辑-验证"闭环。
- 新增**符号搜索工具** `code.workspace_symbols`（`src/tools/code/workspaceSymbols.ts`）：基于 `vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)`，返回符号列表（名称、类型、位置、文件）。让 Agent 按"函数/类名"定位，而非全文搜索。
- 新增**引用查找工具** `code.find_references`（`src/tools/code/findReferences.ts`）：基于 `vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position)`，返回所有引用位置。重构时定位所有调用点。
- 新增**跳转定义工具** `code.go_to_definition`（`src/tools/code/goToDefinition.ts`）：基于 `vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position)`，返回定义位置。Agent 探索代码结构。
- 新增**代码索引器**（`src/tools/index/codeIndexer.ts`）：本地 trigram 索引或 ripgrep 轻量索引，提供 `index.search(query, topK)` 接口；增量更新监听 `vscode.workspace.onDidSaveTextDocument`；支持暂停/恢复索引（避免启动卡顿）。类 Claude Code 的上下文检索能力。
- 新增**索引存储**（`src/tools/index/indexStore.ts`）：内存 Map + 可选 sqlite 持久化（`sql.js` 或 `better-sqlite3`），提供 save/load/query 接口，索引存储在 `context.globalStorageUri` 下，重启不丢失。
- 新增**索引搜索工具** `code.search_index`（`src/tools/index/searchIndex.ts`）：将索引器的 `search` 能力暴露为本地工具，Agent 可通过 `code.search_index` 做语义/模糊检索。permissions `read`、site `local`。
- **装配**（`src/extension.ts`）：注册全部新工具到 `ToolRegistry`；初始化代码索引器并启动后台索引。
- **工具清单上报**（步骤 3.23）：Phase 1 已实现 `local_tools` 在会话创建时上报，新工具经此机制自动上报云端，**无需额外协议改动**。验证 `code.*` 工具经 `make_local_tool_wrapper` 自动包装即可。
- **依赖云端**（不在本仓库实现，见 `docs/整体架构计划/Phase3改动计划.md`）：云端 Agent 系统提示增强（指导 LLM 何时用诊断/符号/引用工具）；大结果裁剪策略（诊断/引用列表可能很大）；工具清单动态更新（可选，若索引器延迟就绪）。

## Capabilities

### New Capabilities
- `code-intelligence`: 基于 VSCode Language API 的代码智能工具集--`code.get_diagnostics`（诊断查询）、`code.workspace_symbols`（符号搜索）、`code.find_references`（引用查找）、`code.go_to_definition`（跳转定义）。均为只读工具（permission `read`），无需审批，直接执行。返回结构化数据（位置、严重级别、符号类型等）供 Agent 推理。
- `code-index`: 本地代码索引与上下文检索--`CodeIndexer`（trigram/ripgrep 索引、增量更新、暂停/恢复）+ `IndexStore`（内存 + 可选 sqlite 持久化）+ `code.search_index` 工具（暴露索引检索为本地工具）。保障大工作区下全文检索性能，类 Claude Code 的上下文检索能力。

### Modified Capabilities
<!-- 无现有 spec 的需求层变更。新工具遵循 Phase 1/2 已建立的 BaseTool 契约、ToolRegistry 注册、ToolRouter 路由、local_tools 上报机制，不修改现有 spec 的 requirements。 -->

## Impact

- **新增代码**：`src/tools/code/{getDiagnostics,workspaceSymbols,findReferences,goToDefinition}.ts`、`src/tools/index/{codeIndexer,indexStore,searchIndex}.ts` 及对应单测。
- **改动代码**：`src/extension.ts`（注册新工具 + 初始化索引器）、`src/tools/baseTool.ts`（`ToolContext` 可选增加索引器引用，供 `code.search_index` 使用）。
- **依赖**：索引持久化可选引入 `sql.js` 或 `better-sqlite3`（默认内存模式，sqlite 为可选增强）；trigram 索引纯 TS 实现，无外部依赖。`code.*` 工具依赖 VSCode Language API（`vscode.languages`、`vscode.commands`），无 npm 包依赖。
- **云端依赖（外部）**：云端 Agent 仓库须增强系统提示（指导 LLM 有效使用代码智能工具）与结果裁剪策略，详见 `docs/整体架构计划/Phase3改动计划.md`。本地在云端就绪前可用 mock 云端先行跑通。
- **安全**：全部新工具均为 `read` 权限，无需审批，经 pathGuard 解析路径（涉及文件 URI 的工具）。索引器仅读不写，索引文件存储在 `globalStorageUri` 下。
- **非目标**：终端执行/Git（Phase 4）、Webview 组件化重构（Phase 5）、安全审计与结果裁剪的统一处理（Phase 6）、批量并行 `tool_call_batch`。
