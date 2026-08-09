## 1.Think Before Coding

* [ ] 

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 5. RTK命令执行规范

可以用RTK命令替代原生命令的时候，优先考虑RTK命令节省token

---

## 6. 项目概览

**云效 Agent (`yunxiao-agent`)** — 对接自有 AI Agent 服务的 VSCode 插件：侧边栏对话面板（Webview）、流式回复（SSE）、Markdown 渲染、多会话管理、本地工具执行（文件/代码智能/终端/Git）、审批网关、上下文自动压缩。

- 入口：`src/extension.ts`（`main: ./dist/extension.js`，esbuild 打包产物在 `dist/`）
- 栈：TypeScript (strict) + VSCode API `^1.99` + esbuild + marked（Markdown 渲染）+ simple-git
- 配置项：`yunxiaoAgent.*`（见 `package.json` `contributes.configuration`，模型、工具超时、审批白名单、Skill 目录等）
- 设计文档：`docs/`（实施拆解、架构演进规划）；特性规范：`openspec/specs/`（spec-driven，24 个 spec）

## 7. 常用命令

```bash
npm run check-types   # tsc --noEmit（类型检查）
npm run lint          # eslint src
npm run compile       # check-types + lint + esbuild 打包到 dist/
npm run watch         # watch:*（esbuild + tsc --noEmit 增量监听）
npm run package       # 生产打包（check-types + lint + esbuild --production），产出 .vsix
npm test              # vscode-test（pretest 自动 compile-tests + compile + lint）
```

- 测试：mocha + `@vscode/test-cli`，用例在 `src/test/**/*.test.ts`，编译到 `out/test/`。改测试或源码后跑 `npm test`（或先 `npm run compile-tests`）。
- 提交前必须过 `npm run compile`（含类型检查 + lint）。

## 8. 架构（核心模块）

| 模块                          | 职责                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`          | 激活入口：装配所有依赖（ToolRegistry、ApprovalGateway、SecurityAudit、AgentLoop、LocalSessionManager、Provider），注册命令与 Webview                                                                                                                                          |
| `src/chatPanel.ts`          | 对话面板（WebviewViewProvider）：消息流式渲染、Markdown、新建会话、审批卡片（requestApproval）                                                                                                                                                                                |
| `src/agent/`                | Agent 主循环（`agentLoop.ts`：每轮重载历史 → LLM 调用 → 工具执行 → doom loop 检测/上下文压缩）、`compaction.ts` 压缩、`tokenEstimator.ts` 估算、`systemPrompt.ts`、`toolAdapter.ts` schema 转换                                                                  |
| `src/core/`                 | 基础设施：`toolRegistry` 注册表、`toolRouter` 路由（审批 + 执行 + 结果治理）、`approvalGateway` 审批、`securityAudit` 安全审计、`eventBus` 事件总线、`toolExecutionJournal` 执行台账、`localSessionManager` 会话、`errors.ts` 错误类型、`types.ts` 共享契约 |
| `src/tools/`                | 本地工具层（均继承`BaseTool`，经 `schema`/`validate`/`execute` 契约）：`fs/` 文件读写与路径守卫（pathGuard）、`code/` 代码智能（editFile 需 diff 预览审批）、`git/`、`terminal/`（白名单 + 超时）、`diff/`                                                  |
| `src/llm/`                  | `provider.ts` 工厂 + `openaiProvider.ts`（OpenAI 兼容 /v1/chat/completions）+ `streamParser.ts` SSE 流解析                                                                                                                                                              |
| `src/memory/`               | `messageStore.ts` 会话消息持久化（workspaceState）、`historyLoader.ts` 历史加载供 LLM 使用                                                                                                                                                                                |
| `src/skill/`                | Skill 扫描加载（`skillLoader`）、注册（`skillRegistry`）、工具化（`skillTool`）                                                                                                                                                                                         |
| `src/config/modelConfig.ts` | 从`yunxiaoAgent.model.*` 读取并校验模型配置                                                                                                                                                                                                                                 |

数据流：`chatPanel`（用户输入）→ `localSessionManager` → `agentLoop`（循环）→ `llmProvider`（SSE 流）→ 工具调用经 `toolRouter` → `approvalGateway` 审批 → `tools/*` 执行 → 结果回传 LLM → 事件经 `eventBus` 推送 UI。

## 9. 开发约定（⚠️ 硬性规范，必须遵守）

### 9.1 所有功能关键步骤必须打印日志

- **任何功能的关键步骤（入口、分支、成功/失败、异常捕获）都必须打印日志**，通过 `src/logger.ts` 统一输出：`logger.log(msg, ...args)` / `logger.error(msg, ...args)` / `logger.notifyError(msg, ...args)`（后者弹窗 + Show Logs）。
- 日志写入 VSCode Output Channel「云效 Agent」，禁止绕过 logger 裸用 `console.log`（logger 内部除外）。
- 日志要含可定位信息：会话 ID、文件路径、工具名、耗时等，如 `[AgentLoop] run 开始 sessionId=...`。
- 现状：核心链路（extension/agentLoop/chatPanel）已有日志，但多数 `tools/*` 文件尚无——新增或改动代码时**必须补齐**关键步骤日志。

### 9.2 所有函数必须写注解（入参/出参 + 职责）

- **每个函数/方法都要有 JSDoc**：用中文说明职责、`@param` 标注每个入参、`@returns`（或 `Promise<...>`）标注返回值。
- 导出常量/类型/接口字段也要有一行中文说明注释。
- 每个源文件顶部要有文件职责注释（参照 `src/tools/fs/readFile.ts`、`src/core/eventBus.ts` 的写法）。

### 9.3 代码风格

- 注释、错误消息、日志一律中文。
- 缩进：多数文件用 tab（`chatPanel.ts` 为 2 空格例外——新代码跟随所在文件既有风格）。
- TypeScript strict 全开；接口字段用 `readonly`；类型契约集中在 `src/core/types.ts`、`llm/types.ts`、`memory/types.ts`。
- 新工具开发模式：继承 `tools/baseTool.ts` 的 `BaseTool`，声明 `schema`（工具名 snake_case 如 `fs.read_file`、权限级别 `read/write/execute/destructive`），可选覆盖 `validate`，实现 `execute(args, context)` 返回结构化 `ToolExecutionResult`，然后到 `extension.ts` 注册。
- 安全红线：路径必须经 `pathGuard.resolveWithinRoots` 校验；写/执行类工具走审批网关；返回云端前结果会自动脱敏/截断（`BaseTool.governResult`），工具内不自行打印密钥。

## 10. Notes

（后续补充）
