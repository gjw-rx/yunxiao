## Context

Phase 1 交付了「云端 `tool_call` -> 本地执行 -> `/tool_result` 回传 -> 续流」的最小闭环。Phase 2 在此之上补齐了核心文件操作工具集（写/列/搜/删/移/编辑）与审批网关。现有基础设施：`BaseTool` 契约（schema/validate/execute/permission）、`ToolRegistry`/`ToolRouter`（按 site 分发，路由层集成审批）、`pathGuard`（工作区根解析、越界/符号链接/敏感文件校验）、`SessionManager`（多轮 SSE 续流、超时、取消）、`ApprovalGateway`（写/破坏性工具审批）、`DiffEngine`/`DiffViewer`（diff 生成/预览/应用）。`ToolSchema.permissions` 四级（read/write/execute/destructive），`local_tools` 在会话创建时上报云端，`make_local_tool_wrapper` 自动包装。

Phase 3 在此之上引入**代码智能工具集**与**本地代码索引**。核心新能力是：让 Agent 通过 VSCode Language API 获得类 IDE 的代码理解能力（诊断/符号/引用/定义），并通过本地代码索引保障大工作区的检索性能。全部新工具均为 `read` 权限，无需审批，直接执行。

约束：
- 复用 Phase 1/2 基础设施（BaseTool、ToolRegistry、ToolRouter、pathGuard、SessionManager），不重写。
- 全部新工具为 `read` 权限，不触发审批网关。
- `code.*` 工具依赖 VSCode Language API（`vscode.languages`、`vscode.commands`），无 npm 包依赖。
- 代码索引默认内存模式，sqlite 持久化为可选增强（不硬依赖 `sql.js`/`better-sqlite3`）。
- 不引入终端/Git（Phase 4）；不做 Webview 组件化（Phase 5）；不做统一结果裁剪/安全审计（Phase 6）。
- 不修改现有协议契约（`tool_call`/`/tool_result`/`local_tools`），新工具经既有机制自动上报与包装。

## Goals / Non-Goals

**Goals:**
- 实现 4 个 VSCode Language API 工具：`code.get_diagnostics` / `code.workspace_symbols` / `code.find_references` / `code.go_to_definition`，让 Agent 能查诊断、按符号定位、找引用、跳定义。
- 实现本地代码索引器（trigram + 可选 ripgrep 辅助），支持增量更新、暂停/恢复，提供 `index.search(query, topK)` 接口。
- 实现索引存储（内存 Map + 可选 sqlite 持久化），索引重启不丢失。
- 将索引检索能力暴露为 `code.search_index` 本地工具，Agent 可做模糊/语义检索。
- 全部新工具经 `local_tools` 自动上报云端，无需协议改动。
- 与云端解耦：云端未增强系统提示前，本地可用 mock 云端跑通（工具 schema 上报 + tool_call/tool_result 闭环不依赖云端提示）。

**Non-Goals:**
- 终端执行 / Git 集成 -- Phase 4。
- Webview 组件化、工具调用卡片/diff 预览 UI 升级 -- Phase 5。
- 统一结果裁剪层（大输出截断/脱敏）-- Phase 6（Phase 3 各工具内做基础截断）。
- 批量并行 `tool_call_batch`。
- 语义嵌入索引（向量检索）-- Phase 3 仅做 trigram 文本相似度，向量索引留后续。
- 跨工作区索引 -- Phase 3 仅索引当前工作区根。

## Decisions

### 决策 1：`code.*` 工具直接封装 VSCode Language API，不引入第三方语言服务
- `code.get_diagnostics`：`vscode.languages.getDiagnostics(uri?)` -- 返回 `Diagnostic[]`（severity, message, range, source）。
- `code.workspace_symbols`：`vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)` -- 返回 `SymbolInformation[]`。
- `code.find_references`：`vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position)` -- 返回 `Location[]`。
- `code.go_to_definition`：`vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position)` -- 返回 `Definition | Location[]`。
- **理由**：VSCode 内置 Language API 依赖已安装的语言扩展（TS/Python/Java...），零额外依赖、零重复实现；与 Claude Code 使用 LSP 的思路一致。
- **备选**：自建 LSP 客户端 -- 否决（重复造轮子、需每语言配 server、维护成本高）。
- **trade-off**：依赖用户已装语言扩展；未装扩展的语言，对应工具返回空结果（文档化此限制）。

### 决策 2：位置参数用 `{file, line, column}` 而非 `{uri}`，由工具内部转 `vscode.Uri`
- LLM 生成工具参数时，`file` 用工作区相对路径（如 `src/extension.ts`），`line`/`column` 为 1-based 整数。
- 工具内部：pathGuard 解析 `file` -> `vscode.Uri.file(absPath)` -> `new vscode.Position(line-1, column-1)`。
- **理由**：LLM 更容易生成相对路径（从 `fs.list_dir`/`fs.read_file` 的上下文自然推导），而非 `file:///` URI。与 Phase 1/2 的 `fs.*` 工具路径约定一致。
- **备选**：直接接收 `uri` 字符串 -- 否决（LLM 易格式错误，且绕过 pathGuard 安全边界）。

### 决策 3：`code.get_diagnostics` 支持全量与按文件过滤
- 无参数：返回当前工作区所有文件的诊断（`vscode.languages.getDiagnostics()` 无参版本）。
- `{file}` 参数：仅返回该文件的诊断（`vscode.languages.getDiagnostics(uri)`）。
- 返回结构：`{ diagnostics: [{ file, line, column, endLine, endColumn, severity, message, source }] }`，severity 映射为 `error|warning|info|hint`。
- **基础截断**：全量诊断超过 50 条时，优先返回 error（全部）+ warning（前 20）+ info/hint（截断），附 `{ truncated: true, total: N }`。

### 决策 4：代码索引用 trigram 相似度，不引入向量嵌入
- 索引器对工作区 `.ts/.js/.py/.java/...` 文件做 trigram 分词，构建 `trigram -> Set<{file, line}>` 倒排表。
- `search(query, topK)`：对 query 做 trigram 分词，按 Jaccard 相似度排序，返回 topK 文件片段。
- **理由**：trigram 纯 TS 实现，零外部依赖，启动快；类 Claude Code 的 grep-based 上下文检索本质也是文本匹配。向量嵌入需 embedding 模型（云端调用或本地 ONNX），复杂度高，留后续。
- **备选**：调用云端 embedding API 做语义索引 -- 否决（每文件一次 API 调用，慢且费 token；本地 ONNX runtime 依赖重）。
- **ripgrep 辅助**：索引构建阶段可用 `rg --files` 快速枚举文件列表（复用 Phase 2 的 rg 封装），`rg` 缺失时回退 `vscode.workspace.findFiles`。

### 决策 5：索引存储默认内存，sqlite 为可选增强
- `IndexStore` 接口：`save(entries)` / `load()` / `query(trigrams)` / `clear()`。
- 默认实现 `MemoryIndexStore`：`Map<string, Set<FileRef>>`，插件启动时重建（后台异步，不阻塞 UI）。
- 可选实现 `SqliteIndexStore`：检测 `better-sqlite3` 可用时自动启用，索引持久化到 `context.globalStorageUri/path/index.db`；不可用时回退内存。
- **理由**：内存模式零依赖、够用（工作区 < 10K 文件时 trigram 索引 < 100MB）；sqlite 消除重启重建延迟，但 `better-sqlite3` 是原生模块需编译，不能硬依赖。
- **备选**：仅内存 -- 否决（大工作区每次重启全量重建慢）；硬依赖 sqlite -- 否决（原生模块安装门槛）。

### 决策 6：索引器增量更新 + 暂停/恢复
- 监听 `vscode.workspace.onDidSaveTextDocument` 增量更新索引（重索引单个文件）。
- 监听 `vscode.workspace.onDidDeleteFiles` / `onDidCreateFiles` 增删索引条目。
- 启动时后台异步全量索引（不阻塞 extension activate）；索引完成前 `code.search_index` 返回 `{ status: 'error', error: '索引构建中，请稍后重试' }`。
- 提供 `pause()` / `resume()` 接口（配置项 `yunxiaoAgent.indexEnabled` 控制是否启用索引）。
- **理由**：全量索引可能耗时数秒（大工作区），不能阻塞启动；增量保证索引与文件系统一致；暂停/恢复给用户控制权。

### 决策 7：`code.search_index` 工具暴露索引检索能力
- schema：`code.search_index`、permission `read`、site `local`、parameters `{ query: string, topK?: number }`。
- `execute`：调 `CodeIndexer.search(query, topK ?? 10)`，返回 `{ results: [{ file, line, snippet, score }] }`。
- **理由**：让 Agent 能做模糊检索（"找到所有处理鉴权的代码"），补充 `fs.search_files`（精确正则/glob）的不足。

### 决策 8：结果基础截断（各工具内实现，不引入统一裁剪层）
- `code.get_diagnostics`：超 50 条按 severity 优先截断（决策 3）。
- `code.workspace_symbols`：超 100 条截断，附 `{ truncated: true, total: N }`。
- `code.find_references`：超 50 个引用截断，按文件分组，每文件最多 10 个。
- `code.go_to_definition`：通常 1-3 个结果，不截断。
- `code.search_index`：`topK` 默认 10，上限 50。
- **理由**：Phase 6 会做统一裁剪层（大输出截断/脱敏/分页），Phase 3 各工具内做最小截断防止 token 爆炸即可。
- **格式**：所有工具返回 JSON 字符串（`JSON.stringify(result)`），与 Phase 1/2 约定一致。

## Risks / Trade-offs

- **[语言扩展未安装]**（Medium）-> `code.*` 工具依赖用户已装对应语言扩展；未装时返回空结果并附提示「未找到语言服务，请安装 XX 扩展」。文档化此依赖。
- **[诊断/引用结果过大]**（Medium）-> 各工具内基础截断（决策 8）；Phase 6 统一裁剪层再做分页/脱敏。
- **[索引构建耗时长]**（Medium）-> 后台异步构建，不阻塞启动；构建中 `code.search_index` 返回友好错误；配置项可关闭索引。
- **[sqlite 原生模块安装失败]**（Low）-> 检测 `better-sqlite3` 不可用时自动回退内存模式，不报错；用户无感知。
- **[增量索引遗漏]**（Low）-> 监听 `onDidSaveTextDocument`/`onDidDeleteFiles`/`onDidCreateFiles` 三事件覆盖文件 CUD；若遗漏，下次全量重建修正。提供手动重建命令。
- **[trigram 索引内存占用]**（Low）-> 大工作区（>10K 文件）索引可能 100MB+；限制索引文件大小（沿用 maxFileSize）、文件类型（代码文件白名单）；极端情况用户可关闭索引。
- **[云端系统提示未增强]**（Low）-> LLM 可能不知道何时用代码智能工具；云端增强前，工具 description 写清楚使用场景（如「修改代码后用 get_diagnostics 验证」「重构前用 find_references 找所有调用点」），LLM 据此决策。本地可 mock 跑通。
- **[向后兼容]**（Low）-> 新工具是纯新增；无 `local_tools` 的旧会话仍纯聊天；`read` 工具不触发审批，现有流程零变化。

## Migration Plan

1. **本地先行（mock 云端）**：实现 4 个代码智能工具 + 索引器/存储/搜索工具；扩展 mock 云端使其下发 `code.get_diagnostics`/`code.find_references` 等 `tool_call`，跑通「找引用 -> 改名 -> 验证诊断」端到端。
2. **云端对齐**：云端按 `Phase3改动计划.md` 增强系统提示（指导 LLM 用代码智能工具）与结果裁剪策略。
3. **联调**：本地切真实云端，跑通 Phase 3 验证场景。
4. **回滚**：不在 `local_tools` 上报代码智能工具（或注册表不注册），即回退为 Phase 2 能力；索引器可通过配置关闭。

## Open Questions

- `code.find_references` / `code.go_to_definition` 的 `position` 参数：LLM 是否能可靠生成 `{file, line, column}`？可能需要先 `fs.read_file` 或 `code.workspace_symbols` 获取位置。待联调验证 LLM 的参数生成准确率。
- 索引文件类型白名单：默认索引 `.ts/.tsx/.js/.jsx/.py/.java/.go/.rs/.c/.cpp/.h` 等，是否需要配置项让用户自定义？建议 Phase 3 硬编码常见代码文件，配置项留后续。
- `code.search_index` 与 `fs.search_files` 的定位区分：`search_index` 做模糊/相似度检索（trigram），`search_files` 做精确正则/glob。工具 description 中明确区分，避免 LLM 混用。
