# Implementation Tasks - Phase 2: Core File Tools

> 依赖顺序：依赖/配置 -> 审批网关 -> 路由集成审批 -> diff 引擎 -> 文件工具（写/列/搜/删移）-> diff 可视化 -> code.edit -> 装配 -> UI 接入 -> mock 云端联调。
> 云端侧改动不在本任务清单，见 `docs/整体架构计划/Phase2改动计划.md`。
> 架构步骤编号对齐 `docs/04-架构演进规划.md` Phase 2（2.9-2.16）。

## 1. 依赖与配置

- [x] 1.1 `package.json` 正式引入 `diff` 依赖（`^8.0.4`，从 overrides 提升为 dependencies），`npm install` 验证可解析
- [x] 1.2 `package.json` 新增配置项 `yunxiaoAgent.alwaysAllowTools`（type `array`，items `string`，默认 `[]`，描述「无需审批直接放行的本地工具名列表」）
- [x] 1.3 验证 `npm run check-types` + `npm run lint` 通过 -> verify: 无类型/lint 报错

## 2. 审批网关（步骤 2.9）

- [x] 2.1 创建 `src/core/approvalGateway.ts`，定义 `ApprovalDecision` 类型（`'allow' | 'always' | 'deny'`）与 `ApprovalGateway` 类
- [x] 2.2 构造时读取 `yunxiaoAgent.alwaysAllowTools` 配置初始化持久允许集合；提供 `reloadConfig()` 监听配置变更
- [x] 2.3 实现 `requestApproval(toolName, summary, opts?)`：命中持久/会话允许集合 -> 直接返回 `allow`；否则 `vscode.window.showWarningMessage(summary, '允许','始终允许','拒绝')` 等待用户选择
- [x] 2.4 选择「允许」-> 记入会话级 `Set`（需 `sessionId` 入参或会话作用域）并返回 `allow`；「始终允许」-> 写入 `alwaysAllowTools` 配置（`workspace.getConfiguration().update`）并返回 `always`；「拒绝」/关闭 -> 返回 `deny`
- [x] 2.5 审批提示内容：工具名 + 参数摘要（路径等）；覆盖/删除类操作在摘要中标注「将覆盖/删除」
- [x] 2.6 `requestApproval` 返回 `{ decision, denied?: boolean }`；提供 `shouldGate(permission)` 工具方法（`read` 返回 false，其余 true）
- [x] 2.7 编写单测 `src/test/core/approvalGateway.test.ts`：read 不 gate、命中 alwaysAllow 不弹窗、会话级 allow 复用、deny 返回取消（mock `vscode.window.showWarningMessage` 与配置，AAA 模式）

## 3. 路由集成审批（local-tool-registry 改动）

- [x] 3.1 `src/core/toolRouter.ts` 构造增加 `ApprovalGateway` 注入参数（可选，向后兼容 Phase 1 单测）
- [x] 3.2 `route()` 在 `validate` 之后、`execute` 之前：若 `gateway?.shouldGate(tool.permission)` 为 true，调 `requestApproval`；`deny` -> 返回 `{ status:'cancelled', error:'用户拒绝执行' }`（不调 execute）
- [x] 3.3 决策依据为 `tool.schema.permissions`，不读 `call.require_approval`（防御纵深）
- [x] 3.4 审批等待不计入 `toolTimeoutMs`（在 SessionManager 调整：超时计时从 `route` 内 execute 开始；或 router 拆分 `prepare`/`execute`）-> 按 Open Question 选定方案并在代码注释说明
- [x] 3.5 编写单测扩展 `src/test/core/toolRegistry.test.ts` 或新增 `toolRouter.test.ts`：write 工具 approved 执行、denied 返回 cancelled、read 工具不触发审批、`require_approval:false` 仍 gate write（mock gateway，AAA）

## 4. Diff 引擎（步骤 2.14）

- [x] 4.1 创建 `src/tools/diff/diffEngine.ts`，基于 `diff` 包封装 `parsePatch` / `applyPatch` / `createPatch`（`import { parsePatch, applyPatch, createPatch } from 'diff'`）
- [x] 4.2 定义导出类型：`ParsedPatch`、`ApplyResult { ok: boolean; result: string; conflict?: string }`
- [x] 4.3 实现 `parseDiff(patchStr)` -> `ParsedPatch`；非法输入抛清晰错误
- [x] 4.4 实现 `applyDiff(content, patch)` -> `ApplyResult`：用 `applyPatch(content, patch, { fuzzFactor: 2 })`；apply 失败/返回 false -> `{ ok:false, conflict: '上下文不匹配' }`
- [x] 4.5 实现 `createDiff(original, modified, filename?)` -> unified diff 字符串
- [x] 4.6 编写单测 `src/test/tools/diff/diffEngine.test.ts`：解析合法 diff、拒绝非法 diff、apply 匹配、apply 上下文漂移冲突、createDiff 往返（AAA）

## 5. 写文件工具（步骤 2.10）

- [x] 5.1 创建 `src/tools/fs/writeFile.ts`，继承 `BaseTool`，schema：`fs.write_file`、permission `write`、site `local`、parameters `{ path: string, content: string }`
- [x] 5.2 `validate`：`path` 与 `content` 为非空字符串（`content` 允许空串？决策：允许空串以创建空文件，但 `path` 必须非空）
- [x] 5.3 `execute`：pathGuard 解析 -> stat 检测是否存在（存在则标记 overwrite）-> `mkdir -p` 父目录 -> 原子写（`<target>.<rand>.tmp` + `fs.rename`）
- [x] 5.4 错误处理：pathGuard 越界/无工作区返回 error；写入失败返回 error
- [x] 5.5 审批摘要含路径与「将覆盖」提示（覆盖时）-- 实际审批由路由层触发，工具返回的 metadata 含 `affected_files`
- [x] 5.6 编写单测 `src/test/tools/fs/writeFile.test.ts`：新建文件、覆盖现有、自动建父目录、越界拒绝、原子写成功（AAA，用 tmp 目录 fixture）

## 6. 列目录工具（步骤 2.11）

- [x] 6.1 创建 `src/tools/fs/listDir.ts`，schema：`fs.list_dir`、permission `read`、site `local`、parameters `{ path: string, type?: 'file'|'dir'|'all', recursive?: boolean }`
- [x] 6.2 `execute`：pathGuard 解析目录 -> 优先 `rg --files`（尊重 .gitignore）-> 回退 `vscode.workspace.fs.readDirectory` + 最小 ignore 匹配
- [x] 6.3 返回结构：`{ entries: [{ name, type, size, mtime }] }`；默认非递归（单层），`recursive:true` 递归（限制深度，默认上限如 3）
- [x] 6.4 最小 ignore 匹配：内置 `node_modules`/`.git`/`dist`/`out`/`coverage` + 根 `.gitignore` 简单 glob（文档化限制：不支持嵌套 .gitignore / negation）
- [x] 6.5 编写单测 `src/test/tools/fs/listDir.test.ts`：列目录成功、type 过滤、gitignored 排除、非目录路径 error（AAA，fixture 目录）

## 7. 文件搜索工具（步骤 2.12）

- [x] 7.1 创建 `src/tools/fs/searchFiles.ts`，schema：`fs.search_files`、permission `read`、site `local`、parameters `{ pattern: string, mode?: 'regex'|'glob', path?: string, contextLines?: number }`
- [x] 7.2 `execute`：pathGuard 解析根目录 -> spawn `rg --json -C <n> <pattern>`（regex）或 `rg --files -g <glob>`（glob）-> 解析 `--json` 取 matches + 上下文
- [x] 7.3 `rg` 缺失（spawn ENOENT）回退 Node 原生：遍历文件（限 top N 如 500、单文件 ≤ maxFileSize）+ 正则匹配 + 上下文
- [x] 7.4 返回结构：`{ matches: [{ file, line, column, text, context: string[] }] }`；回退路径超限返回截断提示
- [x] 7.5 编写单测 `src/test/tools/fs/searchFiles.test.ts`：regex 命中（mock rg 或用真实 rg 若环境有）、glob 命中、rg 缺失回退、无匹配空结果（AAA）

## 8. 删除/移动工具（步骤 2.16）

- [x] 8.1 创建 `src/tools/fs/deleteFile.ts`，schema：`fs.delete_file`、permission `destructive`、site `local`、parameters `{ path: string, recursive?: boolean }`
- [x] 8.2 `execute`：pathGuard 解析 -> `vscode.workspace.fs.delete(uri, { useTrash: true, recursive })`；trash 失败回退 `fs.rm` 永久删除，metadata 标注 `permanent: true`
- [x] 8.3 创建 `src/tools/fs/moveFile.ts`，schema：`fs.move_file`、permission `write`、site `local`、parameters `{ from: string, to: string }`
- [x] 8.4 `execute`：pathGuard 解析 from/to -> 检测 to 是否存在（覆盖提示）-> `mkdir -p` to 父目录 -> `fs.rename`（跨设备回退 copy+delete）
- [x] 8.5 编写单测 `src/test/tools/fs/deleteFile.test.ts` 与 `moveFile.test.ts`：删除到回收站、永久删除回退、移动文件、移动覆盖、越界拒绝（AAA，fixture）

## 9. Diff 可视化（步骤 2.15）

- [x] 9.1 创建 `src/tools/diff/diffViewer.ts`，封装 `showDiffPreview(originalUri, modifiedUri, title)` -> `vscode.commands.executeCommand('vscode.diff', ...)`
- [x] 9.2 提供 `createPreviewUri(content, filename)`：用 `vscode.workspace.fs` 写入 `*.code-edit-preview` 临时资源（或 `vscode.Uri.parse` + `ContentProvider`），返回可 diff 的 uri
- [x] 9.3 提供 `cleanupPreview(uri)`：应用/拒绝后删除临时文件
- [x] 9.4 编写单测 `src/test/tools/diff/diffViewer.test.ts`：showDiffPreview 调用 vscode.diff 命令、临时资源创建与清理（mock vscode.commands，AAA）

## 10. 代码编辑工具（步骤 2.13）

- [x] 10.1 创建 `src/tools/code/editFile.ts`，schema：`code.edit`、permission `write`、site `local`、parameters `{ path: string, oldString?: string, newString?: string, patch?: string }`（二选一模式）
- [x] 10.2 `validate`：`path` 非空；`oldString`+`newString` 模式或 `patch` 模式至少一个；两者都给则报错
- [x] 10.3 `execute` 模式 A（oldString/newString）：**重读**文件 -> 校验 `oldString` 唯一出现（0 次「未找到」、>1 次「多处匹配」）-> 替换 -> 得 proposed 内容
- [x] 10.4 `execute` 模式 B（patch）：重读文件 -> `applyDiff(content, patch)` -> `ok:false` 即冲突返回 error -> 得 proposed 内容
- [x] 10.5 生成 diff（`createDiff`）-> `showDiffPreview` 打开对比 -> 审批网关 `requestApproval`（路由层已 gate 一次；此处为「应用前确认」，决策：复用路由层审批即足够，预览后直接应用 OR 预览+二次确认--按 Open Question 选定，建议预览 + 路由审批合一，不二次弹窗）
- [x] 10.6 审批通过 -> 原子写入 proposed -> `cleanupPreview` -> 返回 `metadata: { diff, affected_files: [path] }`
- [x] 10.7 审批拒绝 -> 返回 `cancelled`，不写入，清理预览
- [x] 10.8 pathGuard 解析在读取前；越界返回 error
- [x] 10.9 编写单测 `src/test/tools/code/editFile.test.ts`：精确替换唯一串、多处匹配拒绝、未找到拒绝、patch 应用成功、patch 冲突拒绝、并发修改（重读检测）拒绝、审批拒绝 cancelled（AAA，fixture + mock）

## 11. 装配（extension.ts）

- [x] 11.1 `src/extension.ts` 实例化 `ApprovalGateway`（注入 vscode 配置访问）
- [x] 11.2 `ToolRouter` 构造注入 `ApprovalGateway`
- [x] 11.3 注册全部新工具：`fs.write_file` / `fs.list_dir` / `fs.search_files` / `fs.delete_file` / `fs.move_file` / `code.edit`
- [x] 11.4 `SessionManager` 适配审批等待不计入超时（按 3.4 选定方案）
- [x] 11.5 验证无 `local_tools` 旧会话流程不回归（纯聊天 + read_file 仍正常）-> verify: e2e 纯聊天 + read 轮次通过

## 12. UI 最小接入（chatPanel.ts）

- [x] 12.1 `chatPanel.ts` 转发审批相关事件到 webview（审批 pending/允许/拒绝 的最小文本态展示，精细卡片留 Phase 5）
- [x] 12.2 工具状态卡片补全新工具的展示（write/list/search/delete/move/code.edit 的 pending/running/success/error）
- [x] 12.3 code.edit 成功时可选在消息流展示 diff 摘要（文本态，非组件化预览）
- [x] 12.4 验证审批弹窗（原生 `showWarningMessage`）正常弹出与响应 -> verify: 手动触发 write 工具见弹窗

## 13. Mock 云端与端到端验证

- [x] 13.1 扩展 `src/test/integration/e2e.test.ts` 的 MockCloud：支持下发 `fs.write_file` / `fs.list_dir` / `code.edit` 的 `tool_call` 并接收 `/tool_result`
- [x] 13.2 e2e 场景一「在 src/utils 下加 logger.ts」：list_dir 探索 -> write_file 创建 -> 文件成功创建
- [x] 13.3 e2e 场景二「改名 getServiceBaseUrl -> getServiceUrl」：code.edit 生成 diff -> 审批 -> 应用生效
- [x] 13.4 验证审批拒绝：mock 下发 write_file -> 用户拒绝（mock 自动 deny）-> 回传 cancelled -> 云端续流调整
- [x] 13.5 验证 rg 缺失回退：模拟 rg ENOENT -> search_files 走 Node 回退仍返回结果
- [x] 13.6 跑全量单测，覆盖率维持 >= 80%（statements/branch/funcs）
- [x] 13.7 `npm run check-types` + `npm run lint` + `npm run compile` 通过
- [ ] 13.8 待云端就绪后切换真实云端联调，验证真实 `tool_call`（含 `require_approval`）/ `/tool_result`（含 metadata.diff）闭环（依赖 `Phase2改动计划.md` 完成）
