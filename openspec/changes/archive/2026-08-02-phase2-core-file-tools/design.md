## Context

Phase 1 交付了「云端 `tool_call` -> 本地执行 -> `/tool_result` 回传 -> 续流」的最小闭环，首个本地工具 `fs.read_file`（只读、无需审批）已跑通。现有基础设施：`BaseTool` 契约（schema/validate/execute/permission）、`ToolRegistry`/`ToolRouter`（按 site 分发，路由层盖 call_id）、`pathGuard`（工作区根解析、越界/符号链接/敏感文件校验）、`SessionManager`（多轮 SSE 续流、超时、取消）、`ToolContext`（注入 workspaceRoots/maxFileSize/warn）。`ToolSchema.permissions` 已定义 `read | write | execute | destructive` 四级，但 Phase 1 仅用 `read`；`ToolCall.require_approval` 字段已存在于协议但云端 Phase 1 始终发 `false`。

Phase 2 在此之上引入**变更类工具**（写/列/搜/删/移/编辑），核心新约束是：**任何变更操作必须经用户审批**。这带来两个设计焦点--(1) 审批闸门挂在哪一层、用什么 UI；(2) `code.edit` 的精准编辑 + diff 预览如何安全应用。本设计聚焦本地侧；云端侧改动见 `docs/整体架构计划/Phase2改动计划.md`。

约束：
- 复用 Phase 1 基础设施（pathGuard、BaseTool、ToolRouter、SessionManager、EventBus），不重写。
- 路径安全仍是 CRITICAL--所有新 `fs.*` 工具必须经 pathGuard。
- 不引入终端/Git/代码索引/诊断（Phase 3-4）；不做 Webview 组件化重构（Phase 5）。
- `diff` npm 包已在 `package.json` overrides（`^8.0.4`），本阶段正式依赖。

## Goals / Non-Goals

**Goals:**
- 建立审批网关：变更操作执行前用户确认，三选项（本次会话允许/始终允许/拒绝），只读自动放行。
- 补齐文件操作全集：`fs.write_file` / `fs.list_dir` / `fs.search_files` / `fs.delete_file` / `fs.move_file`。
- 实现 Claude Code 风格精准编辑：`code.edit`（精确替换 + unified diff 两种模式）+ diff 预览 + 冲突检测。
- 提供 diff 引擎（解析/应用/冲突检测）作为 `code.edit` 底层依赖。
- 安全：写/删/移经审批 + pathGuard 双重校验；删除优先回收站；编辑应用前重读防并发覆盖。
- 与云端解耦：云端未实现 `require_approval` 路由前，本地可用 mock 云端跑通（本地按自身 permission 判定，不依赖云端标志）。

**Non-Goals:**
- 代码智能（诊断/符号/引用/索引）-- Phase 3。
- 终端执行 / Git 集成 -- Phase 4。
- Webview 组件化、精细审批/diff 卡片 UI -- Phase 5（Phase 2 用原生 `vscode.window` 与 `vscode.diff`）。
- 批量并行 `tool_call_batch`。
- diff 引擎的完整三方合并（merge conflict resolution UI）-- Phase 2 仅做冲突**检测**与拒绝，不自动合并。

## Decisions

### 决策 1：审批闸门挂在工具路由层（router），非各工具内部、非会话状态机
`ToolRouter.route()` 在 `validate` 之后、`execute` 之前插入审批判定：按 `tool.schema.permissions` 判定，`write`/`execute`/`destructive` 须经 `ApprovalGateway`，拒绝则直接返回 `{status:'cancelled'}`，`read` 直通。
- **理由**：路由层已持有 tool 与 permission（经 registry.lookup），是「分发」的天然扩展点；集中一处避免审批逻辑散落到 6 个写工具；会话状态机保持专注流协调，不被工具语义污染。
- **备选 A**：各写工具在 `execute` 内部各自调网关 -- 否决（散落、易遗漏、不一致）。
- **备选 B**：`SessionManager.executeWithTimeout` 内调网关 -- 否决（把工具语义拉进流协调层，职责混淆）。

### 决策 2：本地按自身 `permission` 判定，不信任云端 `require_approval` 标志（防御纵深）
云端 `tool_call.require_approval` 仅为信息性提示；本地路由始终以 `tool.schema.permissions` 为准强制审批。即使云端漏发 `require_approval:true`，本地写工具仍会弹审批。
- **理由**：审批是本地安全策略，不能依赖远端正确性；与 Claude Code「本地是安全边界」一致。
- **备选**：仅当 `call.require_approval === true` 才审批 -- 否决（云端 bug 即变安全漏洞）。

### 决策 3：审批 UI 用 `vscode.window.showWarningMessage` 三按钮，Webview 对话框留 Phase 5
```
showWarningMessage(`<tool> 将修改工作区：\n<参数摘要>`, { modal:false }, '允许','始终允许','拒绝')
```
- **理由**：原生 API 即满足三选项需求，无 Webview 往返、无新消息协议；Phase 5 组件化时再迁移为 `ApprovalDialog` 组件。
- **备选**：Webview 自定义对话框 -- 否决（Phase 5，需新增 host↔webview 审批消息协议，复杂度高，本阶段性价比低）。
- **会话级允许**：内存 `Set<toolName>`（per session）；**始终允许**：写入配置 `yunxiaoAgent.alwaysAllowTools`（string[]，用户可在 settings 编辑）。网关启动时读配置，命中即放行。

### 决策 4：`fs.write_file` 原子写入（同目录临时文件 + rename）
写入 `<target>.<rand>.tmp` -> `fs.rename` 到目标。自动 `mkdir -p` 父目录。覆盖检测：若目标已存在，审批提示包含「将覆盖现有文件」。
- **理由**：rename 在同文件系统是原子的，崩溃时不留半截文件；与 Claude Code 写文件语义一致。
- **备选**：直接 `fs.writeFile` -- 否决（崩溃留下部分写入）。

### 决策 5：`fs.search_files` 与 `fs.list_dir` 优先 ripgrep，回退 Node 原生
- `search_files`：spawn `rg --json -C 2 <pattern>`（正则）/ `rg --files -g <glob>`（glob）。解析 `--json` 输出取匹配行 + 上下文。`rg` 缺失（ENOENT）时回退 Node：`search_files` 用逐文件读取 + 正则匹配（限制扫描文件数与大小，避免 OOM）。
- `list_dir`：优先 `rg --files`（天然尊重 .gitignore、快），回退 `vscode.workspace.fs.readDirectory` + 最小 ignore 匹配（内置常见忽略：`node_modules`/`.git`/`dist`/`out`/`coverage` + 根 `.gitignore` 简单 glob）。
- **理由**：rg 是 Claude Code grep/glob 的工业标准，性能最佳且尊重 .gitignore；回退保证无 rg 环境可用。
- **备选**：仅 Node 原生 -- 否决（大工作区慢）；硬依赖 rg -- 否决（缺失即不可用）。
- **trade-off**：回退路径的 .gitignore 语义不完整（不支持嵌套 .gitignore、negation `!`）-- 文档化限制，rg 可用时无此问题。

### 决策 6：diff 引擎基于 `diff` npm 包，不手写 patch 算法
`diff` v8 提供 `parsePatch` / `applyPatch` / `createPatch` / `structuredPatch`。diff-engine 封装为我们的类型（`ParsedPatch` / `applyPatchResult`），`applyPatch` 用其 `{fuzzFactor}` 选项做空白容忍，并在 apply 前后做内容比对以**检测冲突**（apply 返回 `false` 即冲突拒绝）。
- **理由**：patch 应用算法（上下文匹配、fuzz）成熟且复杂，手写易错；`diff` 包小且已在 overrides。
- **备选**：手写 unified diff parser+applier -- 否决（High 风险、重复造轮子）。
- **三向合并**：Phase 2 不做自动合并，仅检测冲突并返回 `error`（提示用户文件已变，请重读）。

### 决策 7：`code.edit` 两种模式 + 应用前重读冲突检测
- 模式 A `{path, oldString, newString}`：读文件 -> 校验 `oldString` 在文件中**唯一存在**（0 次报"未找到"、>1 次报"多处匹配需更上下文"）-> 替换 -> 生成 diff。
- 模式 B `{path, patch}`：`parsePatch` + `applyPatch`（fuzzFactor 容忍）。
- **冲突检测**：执行时重新读文件（不信任之前 read 的缓存），模式 A 重新校验 oldString 唯一性；模式 B apply 失败即冲突。任一冲突返回 `error`，不写入。
- **预览**：生成 proposed 内容 -> `vscode.diff(originalUri, proposedUri, title)` 打开 diff 编辑器 -> `showWarningMessage('应用此变更？', '应用','拒绝')`。用户可在 diff tab 查看后回对话框确认。proposed 用 `vscode.workspace.fs` 写入临时 `*.code-edit-preview` 资源。
- **理由**：Claude Code 精准编辑的核心是「最小替换 + 预览 + 确认」；重读防并发覆盖（用户/其他工具在 Agent 推理期间改了文件）。

### 决策 8：`fs.delete_file` 优先回收站
`vscode.workspace.fs.delete(uri, { useTrash: true })`。审批提示明示「删除」并给出路径。回收站不可用（如某些远程/容器环境）时回退永久删除并在结果中标注。
- **理由**：删除不可逆，回收站给用户后悔权；与 VSCode 原生删除一致。
- **备选**：永久删除 -- 否决（风险高）。

### 决策 9：新增配置 `yunxiaoAgent.alwaysAllowTools`
`string[]`，默认 `[]`。ApprovalGateway 启动读取，命中工具名即跳过审批。用户可在 settings.json 手动增删。会话级「允许」仅存内存，不落配置。
- **理由**：复用 VSCode 配置体系，用户可见可编辑，无需自建持久化；与会话级记忆职责分离。

## Risks / Trade-offs

- **[审批 UX 粗糙]**（Medium）-> Phase 2 用 `showWarningMessage` 纯文本提示，无参数可视化、无 diff 内嵌。Phase 5 迁移 Webview `ApprovalDialog`/`ToolCallCard`。本阶段保证功能正确，体验留后续。
- **[ripgrep 缺失回退性能]**（Medium）-> Node 回退限制扫描文件数（如 top 500）与单文件大小（沿用 maxFileSize），超限返回截断提示；rg 可用时无此问题。文档化回退为「尽力而为」。
- **[diff apply 模糊匹配误应用]**（High）-> `applyPatch` 的 fuzzFactor 设为保守值（如 2 行），apply 后回读比对预期结果，不一致即拒绝并报冲突；单测覆盖上下文漂移、空白变化场景。
- **[并发修改覆盖]**（High）-> `code.edit` 应用前**重读**文件并校验 oldString/patch 上下文，不使用缓存内容；冲突时返回 `error` 提示重读，不强行覆盖。
- **[审批弹窗阻塞流]**（Medium）-> `showWarningMessage` 是 await 的，会阻塞 `route()` 直至用户响应。工具执行超时（toolTimeoutMs）从用户响应后开始计；或审批等待单独不计入超时（实现时明确：审批等待不触发超时，仅执行阶段计时）。
- **[云端未发 require_approval]**（Low）-> 本地按自身 permission 判定（决策 2），不依赖云端标志；云端就绪前可 mock 跑通。
- **[回收站不可用]**（Low）-> `useTrash` 失败回退永久删除并在结果 metadata 标注 `permanent: true`；审批提示已明示删除风险。
- **[向后兼容]**（Low）-> 新工具是纯新增；无 `local_tools` 的旧会话仍纯聊天。审批仅对 write/destructive 生效，read 流程零变化。

## Migration Plan

1. **本地先行（mock 云端）**：实现审批网关 + 全部新工具 + diff 引擎；扩展 mock 云端（Phase 1 e2e 的 MockCloud）使其下发 `fs.write_file`/`code.edit` 等 `tool_call`，跑通「建 logger.ts」「改名 getServiceBaseUrl」端到端。
2. **云端对齐**：云端按 `Phase2改动计划.md` 实现 `require_approval` 路由（按 permissions 置位）与 `cancelled` 续流。
3. **联调**：本地切真实云端，跑通 Phase 2 两条验证场景。
4. **回滚**：通过配置开关--不在 `local_tools` 上报写工具（或注册表不注册），即回退为 Phase 1 只读能力；云端无 `require_approval` 时本地仍按 permission 自主审批，无需云端回滚。

## Open Questions

- 审批等待是否计入 `toolTimeoutMs`：建议**不计入**（仅执行阶段计时），需在 SessionManager 实现「审批 await 与执行 await 分别计时」或调整超时起点。待 tasks 阶段确认实现方式。
- `code.edit` 预览的 proposed 临时资源清理时机：diff 编辑器关闭后清理 vs 立即清理（应用后即删）。建议应用/拒绝后即删临时文件。
- `fs.list_dir` 深度：是否限制递归深度（如默认 2 层）避免超大目录树爆 token。建议默认返回单层 + 可选 `recursive`/`depth` 参数。
