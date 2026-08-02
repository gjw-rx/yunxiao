# Implementation Tasks - Phase 3: Code Intelligence & Context Retrieval

> 依赖顺序：配置 -> 诊断工具 -> 符号搜索 -> 引用查找 -> 跳转定义 -> 索引存储 -> 代码索引器 -> 索引搜索工具 -> 装配 -> UI 接入 -> mock 云端联调。
> 云端侧改动不在本任务清单，见 `docs/整体架构计划/Phase3改动计划.md`。
> 架构步骤编号对齐 `docs/04-架构演进规划.md` Phase 3（3.17-3.23）。

## 1. 依赖与配置

- [ ] 1.1 `package.json` 新增配置项 `yunxiaoAgent.indexEnabled`（type `boolean`，默认 `true`，描述「是否启用本地代码索引」）
- [ ] 1.2 `package.json` 新增可选依赖 `better-sqlite3`（optionalDependencies，用于索引持久化；安装失败不影响功能）
- [ ] 1.3 验证 `npm run check-types` + `npm run lint` 通过 -> verify: 无类型/lint 报错

## 2. 诊断查询工具（步骤 3.17）

- [ ] 2.1 创建 `src/tools/code/getDiagnostics.ts`，继承 `BaseTool`，schema：`code.get_diagnostics`、permission `read`、site `local`、parameters `{ file?: string }`（file 为工作区相对路径，可选）
- [ ] 2.2 `validate`：`file` 若提供则为非空字符串（可选参数）
- [ ] 2.3 `execute`：若有 `file` -> pathGuard 解析 -> `vscode.Uri.file(absPath)` -> `vscode.languages.getDiagnostics(uri)`；若无 `file` -> `vscode.languages.getDiagnostics()` 返回全量
- [ ] 2.4 返回结构：`{ diagnostics: [{ file, line, column, endLine, endColumn, severity, message, source }] }`，severity 映射 `DiagnosticSeverity` 枚举为 `error|warning|info|hint` 字符串
- [ ] 2.5 基础截断：诊断超 50 条时，返回全部 error + 前 20 warning + 附 `{ truncated: true, total: N }`
- [ ] 2.6 错误处理：pathGuard 越界返回 error；文件不存在返回 error；无语言服务返回空数组 success
- [ ] 2.7 编写单测 `src/test/tools/code/getDiagnostics.test.ts`：指定文件诊断、全量诊断、截断逻辑、文件不存在、越界拒绝、无语言服务空数组（mock `vscode.languages.getDiagnostics`，AAA 模式）

## 3. 符号搜索工具（步骤 3.18）

- [ ] 3.1 创建 `src/tools/code/workspaceSymbols.ts`，继承 `BaseTool`，schema：`code.workspace_symbols`、permission `read`、site `local`、parameters `{ query: string }`（query 非空字符串）
- [ ] 3.2 `validate`：`query` 为非空字符串，否则抛 `ToolValidationError`
- [ ] 3.3 `execute`：`vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)` -> 获取 `SymbolInformation[]`
- [ ] 3.4 返回结构：`{ symbols: [{ name, kind, file, line, column }] }`，kind 映射 `SymbolKind` 枚举为可读字符串（如 `Function`/`Class`/`Variable`）
- [ ] 3.5 基础截断：结果超 100 条时截断，附 `{ truncated: true, total: N }`
- [ ] 3.6 错误处理：命令执行失败返回 error；无结果返回空数组 success
- [ ] 3.7 编写单测 `src/test/tools/code/workspaceSymbols.test.ts`：搜索命中、无匹配空数组、截断逻辑、空 query 校验拒绝（mock `vscode.commands.executeCommand`，AAA）

## 4. 引用查找工具（步骤 3.19）

- [ ] 4.1 创建 `src/tools/code/findReferences.ts`，继承 `BaseTool`，schema：`code.find_references`、permission `read`、site `local`、parameters `{ file: string, line: number, column: number }`（line/column 为 1-based 整数）
- [ ] 4.2 `validate`：`file` 非空字符串；`line` 和 `column` 为 >= 1 的整数，否则抛 `ToolValidationError`
- [ ] 4.3 `execute`：pathGuard 解析 `file` -> `vscode.Uri.file(absPath)` -> `new vscode.Position(line-1, column-1)` -> `vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position)`
- [ ] 4.4 返回结构：`{ references: [{ file, line, column }] }`，按文件分组
- [ ] 4.5 基础截断：引用超 50 个时，每文件最多 10 个，附 `{ truncated: true, total: N }`
- [ ] 4.6 错误处理：pathGuard 越界返回 error；文件不存在返回 error；命令执行失败返回 error；无引用返回空数组 success
- [ ] 4.7 编写单测 `src/test/tools/code/findReferences.test.ts`：查找引用命中、无引用空数组、截断逻辑、1-based 转 0-based 验证、line=0 校验拒绝、越界拒绝（mock `vscode.commands.executeCommand`，AAA）

## 5. 跳转定义工具（步骤 3.20）

- [ ] 5.1 创建 `src/tools/code/goToDefinition.ts`，继承 `BaseTool`，schema：`code.go_to_definition`、permission `read`、site `local`、parameters `{ file: string, line: number, column: number }`（line/column 为 1-based 整数）
- [ ] 5.2 `validate`：`file` 非空字符串；`line` 和 `column` 为 >= 1 的整数
- [ ] 5.3 `execute`：pathGuard 解析 `file` -> `vscode.Uri.file(absPath)` -> `new vscode.Position(line-1, column-1)` -> `vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position)`
- [ ] 5.4 返回结构：`{ definitions: [{ file, line, column }] }`（处理 `Definition | Location[] | LocationLink[]` 多种返回类型）
- [ ] 5.5 错误处理：pathGuard 越界返回 error；文件不存在返回 error；命令执行失败返回 error；无定义返回空数组 success
- [ ] 5.6 编写单测 `src/test/tools/code/goToDefinition.test.ts`：跳转定义命中、无定义空数组、1-based 转 0-based 验证、line=0 校验拒绝、越界拒绝、多种返回类型处理（mock `vscode.commands.executeCommand`，AAA）

## 6. 索引存储（步骤 3.22）

- [ ] 6.1 创建 `src/tools/index/indexStore.ts`，定义 `FileRef` 类型（`{ file: string, line: number }`）与 `IndexStore` 接口（`save`/`load`/`query`/`clear`）
- [ ] 6.2 实现 `MemoryIndexStore`：`Map<string, Set<FileRef>>` 倒排表；`query(trigrams)` 返回 `Map<FileRef, number>`（命中计数作为分数）
- [ ] 6.3 实现 `SqliteIndexStore`（可选）：动态 `import('better-sqlite3')`，成功则用 sqlite 持久化到 `context.globalStorageUri/path/index.db`；失败抛特定错误供上层捕获回退
- [ ] 6.4 提供 `createIndexStore(context): IndexStore` 工厂函数：尝试 sqlite，失败回退内存
- [ ] 6.5 编写单测 `src/test/tools/index/indexStore.test.ts`：内存 store 的 save/load/query/clear、sqlite 回退内存、query 无匹配返回空（AAA）

## 7. 代码索引器（步骤 3.21）

- [ ] 7.1 创建 `src/tools/index/codeIndexer.ts`，实现 `CodeIndexer` 类，依赖 `IndexStore`
- [ ] 7.2 trigram 分词：将文件内容按 3 字符滑窗分词（小写化），构建 `trigram -> Set<FileRef>` 条目
- [ ] 7.3 文件枚举：优先 `rg --files`（复用 Phase 2 的 rg 封装）枚举代码文件；`rg` 缺失回退 `vscode.workspace.findFiles`；按扩展名白名单过滤（`.ts/.tsx/.js/.jsx/.py/.java/.go/.rs/.c/.cpp/.h/.css/.html/.json/.md`）
- [ ] 7.4 全量索引：`buildAll()` 异步遍历文件列表，逐文件读取 + trigram 分词 + store.save；设置 `ready=true` 完成标记
- [ ] 7.5 `search(query, topK=10)`：对 query 做 trigram 分词 -> `store.query(trigrams)` -> 按分数排序取 topK -> 附 snippet（匹配行上下文）-> 返回 `[{ file, line, snippet, score }]`
- [ ] 7.6 增量更新：监听 `onDidSaveTextDocument`（重索引单文件）、`onDidCreateFiles`（新增索引）、`onDidDeleteFiles`（删除索引条目）
- [ ] 7.7 暂停/恢复：`pause()` 停止处理事件；`resume()` 恢复；`isIndexing`/`ready` 属性
- [ ] 7.8 配置联动：`yunxiaoAgent.indexEnabled` 为 `false` 时不启动索引器
- [ ] 7.9 编写单测 `src/test/tools/index/codeIndexer.test.ts`：全量索引 + 搜索命中、增量更新（save 触发重索引）、删除文件移除条目、暂停不处理事件、搜索未就绪返回空、非代码文件排除（AAA，fixture 文件）

## 8. 索引搜索工具

- [ ] 8.1 创建 `src/tools/index/searchIndex.ts`，继承 `BaseTool`，schema：`code.search_index`、permission `read`、site `local`、parameters `{ query: string, topK?: number }`（topK 默认 10，上限 50）
- [ ] 8.2 `validate`：`query` 为非空字符串；`topK` 若提供则为 1-50 整数
- [ ] 8.3 `execute`：检查 `indexer.ready` -> 未就绪返回 `{ status:'error', error:'索引构建中，请稍后重试' }`；`indexEnabled` 为 false 返回 error
- [ ] 8.4 就绪时调 `indexer.search(query, topK)`，返回 `{ results: [{ file, line, snippet, score }] }` JSON 字符串
- [ ] 8.5 `topK` 上限裁剪：传入 > 50 时裁为 50
- [ ] 8.6 编写单测 `src/test/tools/index/searchIndex.test.ts`：搜索命中、topK 默认/自定义/上限裁剪、索引未就绪 error、索引禁用 error、无结果空数组、空 query 校验拒绝（mock `CodeIndexer`，AAA）

## 9. 工具清单上报验证（步骤 3.23）

- [ ] 9.1 验证新工具（`code.get_diagnostics`/`workspace_symbols`/`find_references`/`go_to_definition`/`search_index`）经 `ToolRegistry.list()` 出现在 `local_tools` 上报数组中
- [ ] 9.2 验证 `local_tools` 数组中新工具的 schema 含正确的 `name`/`description`/`parameters`/`permissions:read`/`site:local`
- [ ] 9.3 验证省略 `local_tools` 时旧会话纯聊天不回归 -> verify: e2e 纯聊天通过

## 10. 装配（extension.ts）

- [ ] 10.1 `src/extension.ts` 注册全部新工具到 `ToolRegistry`：`code.get_diagnostics`/`workspace_symbols`/`find_references`/`go_to_definition`/`search_index`
- [ ] 10.2 初始化 `IndexStore`（`createIndexStore(context)`）与 `CodeIndexer`，传入 workspaceRoots；读取 `indexEnabled` 配置
- [ ] 10.3 `CodeIndexer` 启动后台异步全量索引（`buildAll()` 不 await，不阻塞 activate）
- [ ] 10.4 `code.search_index` 工具注入 `CodeIndexer` 引用（通过 `ToolContext` 或构造注入）
- [ ] 10.5 验证无 `local_tools` 旧会话流程不回归（纯聊天 + read_file/write_file 仍正常）-> verify: e2e 纯聊天 + Phase 2 工具轮次通过

## 11. UI 最小接入（chatPanel.ts）

- [ ] 11.1 `chatPanel.ts` 补全新工具的工具状态卡片展示（get_diagnostics/workspace_symbols/find_references/go_to_definition/search_index 的 pending/running/success/error）
- [ ] 11.2 诊断/引用/符号结果可选在消息流展示摘要（文本态，如「找到 3 处引用」「诊断：2 errors, 1 warning」）
- [ ] 11.3 验证工具状态卡片正确显示新工具执行状态 -> verify: 手动触发 get_diagnostics 见状态更新

## 12. Mock 云端与端到端验证

- [ ] 12.1 扩展 `src/test/integration/e2e.test.ts` 的 MockCloud：支持下发 `code.find_references` / `code.edit` / `code.get_diagnostics` 的 `tool_call` 并接收 `/tool_result`
- [ ] 12.2 e2e 场景「找出所有调用 getServiceBaseUrl 的地方，改成 getServiceUrl」：find_references 定位 -> code.edit 批量修改 -> get_diagnostics 验证无错误
- [ ] 12.3 e2e 场景「搜索处理鉴权的代码」：search_index 返回相关文件 -> read_file 读取内容
- [ ] 12.4 e2e 场景「workspace_symbols 定位 activate 函数」：workspace_symbols 返回符号 -> go_to_definition 跳转定义
- [ ] 12.5 验证索引未就绪时 search_index 返回友好错误 -> verify: 启动初期调 search_index 见 error 消息
- [ ] 12.6 验证索引禁用（`indexEnabled: false`）时 search_index 返回 error -> verify: 配置关闭后 search_index 不可用
- [ ] 12.7 跑全量单测，覆盖率维持 >= 80%（statements/branch/funcs）
- [ ] 12.8 `npm run check-types` + `npm run lint` + `npm run compile` 通过
- [ ] 12.9 待云端就绪后切换真实云端联调，验证真实 `tool_call`（含代码智能工具）/ `/tool_result` 闭环（依赖 `Phase3改动计划.md` 完成）
