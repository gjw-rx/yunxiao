## Why

Phase 1-3 让 Agent 能读写文件、精准编辑、查诊断/符号/引用--但它仍只能"看"代码，不能"跑"代码，也不能操作版本控制。这意味着 Agent 无法执行测试/构建/lint 并据结果修复，也无法在改动后提交、查看 diff 决策是否入库。Phase 4 补齐这两块能力：**受控终端执行**（`terminal.exec` + 命令白名单/危险拦截）与 **Git 集成**（status/diff/commit/branch/stash），让 Agent 形成"改代码 -> 跑测试 -> 看结果 -> 修复 -> 提交"的完整闭环。这是从"代码编辑助手"升级到"类 Claude Code 全能助手"的最后一块核心能力。

## What Changes

- 新增**终端执行工具** `terminal.exec`（`src/tools/terminal/terminalExec.ts`）：在 VSCode 集成终端执行命令（用户可见执行过程），捕获 stdout/stderr/exitCode，支持超时（默认 5min）与取消。`permissions: execute`、`site: local`。**所有命令必须经审批**--工具 `handlesOwnApproval: true`，在 `execute` 内先做白名单/危险分类，再按需弹审批（复用 `ApprovalGateway`，与 `code.edit` 同模式）。
- 新增**命令白名单/危险拦截器** `ShellWhitelist`（`src/tools/terminal/shellWhitelist.ts`）：将命令分为三类--
  - `dangerous`：命中危险模式（`rm -rf`、重定向 `>`/`>>`、管道 `|`、命令分隔 `;`/`&&`/`||`、`curl|sh`/`wget|sh` 等）-> **直接拦截**，不弹审批，返回 `cancelled`。
  - `whitelisted`：匹配 `yunxiaoAgent.shellWhitelist` 配置的命令前缀（如 `npm test`、`npm run lint`、`git status`、`node -v`）-> 自动放行，不弹审批。
  - `unknown`：其余命令 -> 走 `ApprovalGateway` 弹用户确认。
- 新增 **Git 客户端工具集**（`src/tools/git/gitClient.ts`），基于 `simple-git` npm 包（成熟稳定，规避 `vscode.git` 内部 API 不稳定风险）：
  - `git.status`（`read`）：工作区状态（已暂存/未暂存/未跟踪文件 + 当前分支）。
  - `git.diff`（`read`）：结构化 diff（按文件分组，支持 `staged`/`unstaged`/`ref` 比较），供 Agent 理解未提交变更。
  - `git.commit`（`write`）：提交已暂存变更（需审批），含提交前二次确认与 commit message 注入校验。
  - `git.branch`（`write`）：分支管理（`list`/`create`/`checkout`）。`write` 权限因 checkout 变更工作区；list 场景可用 `git.status` 获取当前分支免审批。
  - `git.stash`（`write`）：stash 操作（`push`/`pop`/`list`）。
- **装配**（`src/extension.ts`）：注册全部新工具到 `ToolRegistry`；构造 `ShellWhitelist` 与 `simple-git` 实例注入 `TerminalExecTool`。
- **配置项扩展**（`package.json`）：新增 `yunxiaoAgent.shellWhitelist`（string 数组，默认常见安全命令）、`yunxiaoAgent.terminalTimeoutMs`（number，默认 300000=5min）、`yunxiaoAgent.terminalOutputLimit`（number，默认 10000 字符截断）。
- **工具清单上报**：新工具经 Phase 1 的 `local_tools` 机制自动上报云端，**无需协议改动**。`execute`/`write` 权限工具的 `require_approval` 由云端 `make_local_tool_wrapper` 按 `permissions != "read"` 派生（Phase 2 逻辑），自动为 `true`。
- **依赖云端**（不在本仓库实现，见 `docs/整体架构计划/Phase4改动计划.md`）：云端 Agent 系统提示增强（指导 LLM 何时用终端/Git 工具、如何解析测试输出）；大输出裁剪策略（终端 stdout 可能很大）。

## Capabilities

### New Capabilities
- `terminal-tools`: 受控终端执行能力--`terminal.exec` 工具（permission `execute`，site `local`）在 VSCode 集成终端执行命令，捕获 stdout/stderr/exitCode，支持超时与取消；`ShellWhitelist` 安全层做命令三分类（dangerous 拦截 / whitelisted 放行 / unknown 审批）。工具 `handlesOwnApproval: true`，在 execute 内先分类再按需弹审批（复用 ApprovalGateway）。
- `git-tools`: Git 版本控制能力--`git.status`（read）、`git.diff`（read）、`git.commit`（write）、`git.branch`（write）、`git.stash`（write），基于 `simple-git`。read 工具免审批，write 工具经路由层统一审批。

### Modified Capabilities
<!-- 无现有 spec 的需求层变更。terminal.exec/git.* 遵循 Phase 1/2 已建立的 BaseTool 契约、ToolRegistry 注册、ToolRouter 路由、local_tools 上报机制。terminal.exec 的 handlesOwnApproval 与 code.edit 同模式（Phase 2 已建立），不修改 approval-gateway spec。 -->

## Impact

- **新增代码**：`src/tools/terminal/{terminalExec,shellWhitelist}.ts`、`src/tools/git/{gitClient,gitDiff}.ts` 及对应单测。
- **改动代码**：`src/extension.ts`（注册新工具 + 构造 ShellWhitelist/simple-git 注入）、`src/tools/baseTool.ts`（`ToolContext` 可选增加终端输出截断配置）、`src/ui/chatPanel.ts`（新工具状态卡片展示）。
- **依赖**：新增 `simple-git` npm 包（dependencies，~30M 周下载量、成熟稳定，规避手写 git CLI 解析的注入与边界 bug）；`vscode.git` extension API 不采用（内部 API 不稳定）。无原生模块依赖。
- **配置**：`package.json` contributes.configuration 新增 `shellWhitelist`/`terminalTimeoutMs`/`terminalOutputLimit`。
- **云端依赖（外部）**：云端 Agent 仓库须增强系统提示（终端/Git 工具使用指引）与终端大输出裁剪策略，详见 `docs/整体架构计划/Phase4改动计划.md`。本地在云端就绪前可用 mock 云端先行跑通。
- **安全**：`terminal.exec` 为 `execute` 权限，双重安全闸（ShellWhitelist 危险拦截 + ApprovalGateway 用户审批）；git 写工具为 `write` 权限，经路由层审批；`simple-git` 内部转义参数，无 shell 注入风险。
- **非目标**：Webview 组件化重构（Phase 5）、统一安全审计/结果裁剪层（Phase 6）、批量并行 `tool_call_batch`、交互式终端会话（Phase 4 仅支持单次命令执行）、git push/merge/rebase 等远端/高风险操作（留后续）。
