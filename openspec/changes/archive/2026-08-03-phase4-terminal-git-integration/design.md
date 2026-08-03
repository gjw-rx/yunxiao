## Context

Phase 1-3 已建立完整混合编排基础设施：`BaseTool` 契约（schema/validate/execute/permission）、`ToolRegistry`/`ToolRouter`（按 site 分发，路由层集成审批）、`pathGuard`、`SessionManager`（多轮 SSE 续流/超时/取消）、`ApprovalGateway`（read 免审批，write/execute/destructive 弹三选项「允许/始终允许/拒绝」，会话级 + 持久级允许记忆）、`DiffEngine`/`DiffViewer`。`handlesOwnApproval` 机制已由 `code.edit`（Phase 2）验证：路由层对 `handlesOwnApproval=true` 的工具跳过统一审批，由工具在 `execute` 内自行调 `ApprovalGateway.requestApproval()`。

现有 `ToolRouter.route()` 逻辑：`handlesOwnApproval` 工具跳过路由层审批门，直接进 `execute`；非 `handlesOwnApproval` 的 write/execute/destructive 工具由路由层统一弹审批。`ApprovalGateway.requestApproval(toolName, summary, sessionId, callId)` 返回 `'allow'|'always'|'deny'`，命中持久/会话允许则直通。

Phase 4 在此之上引入**终端执行**与 **Git 集成**。核心新风险：终端命令可执行任意 shell（命令注入、危险命令、工作区污染），是所有工具中风险最高的。Git 写操作变更版本库状态，需审批。

约束：
- 复用 Phase 1-3 基础设施（BaseTool、ToolRegistry、ToolRouter、ApprovalGateway、SessionManager），不重写。
- `terminal.exec` 为 `execute` 权限，`handlesOwnApproval: true`（需在弹审批前先做危险命令拦截）。
- git 写工具（commit/branch/stash）为 `write` 权限，走路由层统一审批（非 handlesOwnApproval）。
- 不修改现有协议契约（`tool_call`/`/tool_result`/`local_tools`），新工具经既有机制自动上报与包装。
- 不引入 Webview 组件化（Phase 5）、统一结果裁剪/安全审计（Phase 6）。

## Goals / Non-Goals

**Goals:**
- 实现 `terminal.exec` 工具：执行 shell 命令，捕获 stdout/stderr/exitCode，支持超时（默认 5min）与取消，输出截断防 token 爆炸。
- 实现 `ShellWhitelist` 安全层：危险命令硬拦截、白名单自动放行、未知命令走审批。
- 实现 5 个 Git 工具（status/diff/commit/branch/stash），基于 `simple-git`，覆盖 Agent 版本控制基本需求。
- 全部新工具经 `local_tools` 自动上报云端，无需协议改动。
- 与云端解耦：云端未增强系统提示前，本地可用 mock 云端跑通。

**Non-Goals:**
- 交互式终端会话（Phase 4 仅单次命令执行，不处理 stdin 交互）。
- git push/merge/rebase/reset 等远端或高风险操作 -- 留后续阶段。
- Webview 组件化、工具调用卡片 UI 升级 -- Phase 5。
- 统一结果裁剪层（大输出截断/脱敏）-- Phase 6（Phase 4 各工具内做基础截断）。
- 批量并行 `tool_call_batch`。
- 在用户实际 VSCode 终端中执行（见决策 3 取舍）。

## Decisions

### 决策 1：`terminal.exec` 用 `handlesOwnApproval: true` + `ShellWhitelist` 前置拦截

`terminal.exec` 设置 `handlesOwnApproval = true`，构造注入 `ApprovalGateway` 与 `ShellWhitelist`。`execute` 内流程：

1. `shellWhitelist.classify(command)` 返回 `'dangerous' | 'whitelisted' | 'unknown'`：
   - `dangerous` -> 直接返回 `{ status: 'cancelled', error: '危险命令已被拦截: <reason>' }`，**不弹审批**（避免向用户展示危险命令诱导误批）。
   - `whitelisted` -> 跳过审批，直接执行（白名单为安全命令如 `npm test`）。
   - `unknown` -> 调 `approval.requestApproval('terminal.exec', summary, sessionId)`，`deny` 返回 cancelled，`allow`/`always` 执行。
2. 执行命令，捕获输出，截断，返回。

- **理由**：危险命令必须在弹审批**之前**拦截（否则用户可能误批 `rm -rf`）；`handlesOwnApproval` 是 `code.edit` 已验证的模式，路由层天然跳过，工具内自行编排「分类 -> 审批 -> 执行」。
- **备选**：路由层统一审批 + 工具内危险拦截 -- 否决（危险命令仍会先弹窗，用户误批后工具内拦截虽能兜底但 UX 差，且向用户展示危险命令本身有诱导性）。
- **与 `alwaysAllowTools` 的关系**：因 `handlesOwnApproval=true`，路由层不查 `alwaysAllowTools`；但 `ApprovalGateway.requestApproval` 内部仍查持久/会话允许列表，故 `terminal.exec` 加入 `alwaysAllowTools` 后，`unknown` 类命令会命中持久允许直通（`whitelisted` 类本就免审批，`dangerous` 类永远拦截不受允许列表影响）。语义自洽。

### 决策 2：`ShellWhitelist` 三分类

`ShellWhitelist.classify(command): { category, reason? }`：

- **dangerous**（硬编码危险模式，正则匹配，大小写不敏感）：
  - `rm -rf` / `rm -fr` / `rmdir /s`
  - 重定向覆盖：` > ` / `>>`（写文件）
  - 管道 `|`（命令链，可注入）
  - 命令分隔 `;` / `&&` / `||`（多命令，可注入）
  - `curl | sh` / `wget | sh` / `curl | bash`（远程脚本执行）
  - `chmod 777`、`chown`（权限变更）
  - `sudo`（提权）
  - `:(){:|:&};:`（fork bomb）
  - `mkfs`、`dd if=`（磁盘破坏）
  - `git push --force` / `git reset --hard`（git 破坏性，git 工具不经过 terminal.exec 但 LLM 可能尝试）
- **whitelisted**：命令前缀匹配 `yunxiaoAgent.shellWhitelist` 配置（默认：`npm test`、`npm run lint`、`npm run build`、`npm run check`、`git status`、`git diff`、`git log`、`git branch`、`node -v`、`npm -v`、`tsc --noEmit`、`python -m pytest`、`go test`、`cargo test`）。匹配规则：命令去除前导空格后，以白名单条目为前缀（如 `npm test -- --grep foo` 匹配 `npm test`）。
- **unknown**：其余所有命令 -> 走审批。

- **理由**：三分类覆盖安全光谱两端--危险命令零容忍拦截，安全命令免打扰，中间地带交用户决策。危险模式硬编码（不可配置，防止用户误放行）；白名单可配置（用户可扩展安全命令集）。
- **trade-off**：白名单前缀匹配可能被绕过（如 `npm test; rm -rf /` 含 `;` 会被 dangerous 拦截，因为 `;` 优先匹配）。匹配顺序：先查 dangerous（任一命中即拦截），再查 whitelisted，最后 unknown。`npm test; rm -rf /` 因含 `;` 被判 dangerous，正确。
- **备选**：仅黑白名单两分类 -- 否决（无「未知需审批」中间态，要么放行要么拦截，灵活性不足）。

### 决策 3：终端执行用 `child_process.spawn`，不用 VSCode Terminal API

`terminal.exec` 用 `child_process.spawn(shell, ['-c', command], { cwd: workspaceRoot })` 执行，捕获 stdout/stderr/exitCode。

- **理由**：
  - 可靠捕获 stdout/stderr/exitCode（Agent 解析测试结果的前提）；VSCode `Terminal.shellIntegration.executeCommand().read()` 在 `engines.vscode: ^1.99.0` 下不可用（`read()` 为较新 proposed API），捕获不可靠。
  - 可靠超时（`setTimeout` + `proc.kill()`）与取消（`AbortController` -> `proc.kill()`）。
  - 非交互执行符合 Agent 自动化场景（交互式命令 Agent 无法响应 stdin）。
  - Claude Code CLI 同样以内联捕获方式执行命令，不共享用户终端。
- **用户可见性**：执行过程与输出通过聊天面板工具卡片展示（命令、stdout/stderr 摘要、exitCode、耗时），满足「用户可见执行过程」的诉求（通过 UI 而非终端）。
- **备选**：VSCode Terminal API -- 否决（捕获不可靠、超时/取消难实现、proposed API 不稳定）。
- **shell 选择**：Windows 用 `cmd.exe /c` 或 `powershell -Command`（按 `process.platform` 选），Unix 用 `/bin/sh -c`。通过 `process.env.ComSpec` / `process.env.SHELL` 检测。

### 决策 4：Git 客户端用 `simple-git`，不用 `vscode.git` extension API

引入 `simple-git` npm 包（dependencies）作为 Git 操作底层。`simpleGit(workspaceRoot)` 创建实例，调用 `.status()`/`.diff()`/`.commit()`/`.branch()`/`.checkout()`/`.stash()`。

- **理由**：
  - `simple-git` 成熟稳定（~30M 周下载量），正确处理参数转义、输出解析、路径含空格/unicode、错误码等边界，规避手写 `child_process` git 调用的注入与解析 bug。
  - `vscode.git` extension API 是**内部非稳定公开 API**（`getExtension('vscode.git').exports`），版本间可能 breaking，且获取 API 路径 hacky（需 `activate` + 拿 `API` + `repositories`）。架构演进规划风险表明确指引「优先 `simple-git`，git extension API 仅作优化」。
  - `simple-git` 纯 JS（spawn `git` 子进程），无原生模块依赖，无 Electron ABI 问题（对比 Phase 3 `better-sqlite3` 教训）。
- **备选**：手写 `child_process` spawn git -- 否决（解析 `--porcelain`/diff 输出易错、参数转义风险）；`vscode.git` API -- 否决（不稳定）。
- **trade-off**：新增一个 dependency，但 `simple-git` 体积小、零原生依赖、维护活跃，风险可控。

### 决策 5：`git.branch` 为 `write` 权限，支持 list/create/checkout

`git.branch` 单工具，`action` 参数支持 `list`（默认）/`create`/`checkout`，permission `write`。

- **理由**：`checkout` 变更工作区（mutating），按「可变即 write」的防御纵深原则，整工具定 `write`；与架构演进规划「git.branch」单一工具对齐；`write` 权限走路由层统一审批，会话级允许记忆使同 session 内后续调用免再弹（首次 list 会弹一次审批，但 `git.status`（read）可获取当前分支免审批，LLM 应优先用 status 查看分支状态）。
- **备选**：拆 `git.branch_list`（read）+ `git.branch`（write）-- 否决（工具数膨胀，偏离架构规划命名）。
- **trade-off**：`action: list` 也会触发审批（因工具级 write）。缓解：系统提示指引 LLM「查看当前分支用 `git.status`，分支管理用 `git.branch`」；用户可「始终允许」。

### 决策 6：输出截断策略

- `terminal.exec`：stdout/stderr 各截断至 `yunxiaoAgent.terminalOutputLimit`（默认 10000 字符），超限标注 `{ truncated: true, total: N }`，保留**尾部**输出（错误信息通常在末尾）。
- `git.diff`：diff 输出截断至 10000 字符，超限按文件分组截断（保留每个文件前若干 hunk）。
- `git.status`：文件列表超 200 条截断。
- **理由**：Phase 6 会做统一裁剪层，Phase 4 各工具内做最小截断防 token 爆炸。终端输出保留尾部因错误/堆栈在末尾。

### 决策 7：超时与取消

- `terminal.exec` 超时：`yunxiaoAgent.terminalTimeoutMs`（默认 300000 = 5min），到时 `proc.kill('SIGTERM')`，宽限 2s 后 `SIGKILL`，返回 `{ status: 'error', error: '命令执行超时（<N>s）' }`。
- 取消：`SessionManager` 用户中断时 abort，`terminal.exec` 通过 `AbortSignal` 监听并 kill 子进程，返回 `{ status: 'cancelled', error: '用户取消执行' }`。
- git 工具：复用 `ToolContext.toolTimeoutMs`（默认 30s），simple-git 操作通常快速，超时由路由层 `Promise.race` 兜底。

## Risks / Trade-offs

- **[命令注入绕过白名单]**（High）-> ShellWhitelist 危险模式硬编码 + 匹配优先级（dangerous 先于 whitelisted）；白名单前缀匹配含分隔符的命令会被 dangerous 拦截（`;`/`|`/`&&`）；`handlesOwnApproval` 确保危险命令不弹审批。单测覆盖绕过尝试（如 `npm test;rm -rf /`、`npm test$(rm -rf /)`）。命令替换 `$()` 暂归 unknown 走审批（非 dangerous），后续可加规则。
- **[危险模式漏判]**（Medium）-> 危险模式列表不可能穷举；未知危险命令走审批门，用户可拒绝。文档化「白名单外的命令均需审批」为安全边界。Phase 6 安全审计模块统一加固。
- **[终端输出过大]**（Medium）-> 默认截断 10000 字符，保留尾部；Phase 6 统一裁剪层做分页/脱敏。
- **[simple-git 依赖]**（Low）-> 成熟包、零原生依赖；锁定版本；`npm audit` 监控。
- **[git.branch list 触发审批]**（Low）-> 系统提示指引用 `git.status` 查分支；会话级允许记忆缓解；用户可「始终允许」。
- **[非交互命令卡死]**（Medium）-> 超时 5min + SIGTERM/SIGKILL 兜底；取消信号 kill 子进程。交互式命令（如 `npm install` 需确认）超时后友好提示「命令可能等待交互输入」。
- **[Windows/Unix shell 差异]**（Medium）-> 按 `process.platform` 选 shell（Windows: `cmd.exe /c`，Unix: `/bin/sh -c`）；单测覆盖双平台参数转义。
- **[云端系统提示未增强]**（Low）-> LLM 可能不知道何时用终端/Git；工具 description 写清楚使用场景；本地可 mock 跑通。

## Migration Plan

1. **本地先行（mock 云端）**：实现 `ShellWhitelist` + `terminal.exec` + 5 个 git 工具；扩展 mock 云端下发 `terminal.exec`/`git.status` 等 `tool_call`，跑通「跑测试 -> 解析失败 -> 修复 -> 再跑」端到端。
2. **云端对齐**：云端按 `Phase4改动计划.md` 增强系统提示（终端/Git 工具使用指引）与输出裁剪策略。
3. **联调**：本地切真实云端，跑通 Phase 4 验证场景。
4. **回滚**：不在 `local_tools` 上报终端/Git 工具（或注册表不注册），即回退为 Phase 3 能力。

## Open Questions

- **命令替换 `$()` 与反引号**：`$(cmd)` / `` `cmd` `` 是否归入 dangerous？当前归 unknown 走审批（避免误杀合法命令如 `echo $(date)`）。待联调观察 LLM 是否生成恶意替换，再决定是否升级为 dangerous。
- **`terminal.exec` 的 `cwd`**：固定取 `workspaceRoots[0]`，还是支持 LLM 指定子目录？Phase 4 固定工作区根（简化安全模型）；子目录支持留后续（需 pathGuard 校验）。
- **git.commit 的提交信息校验**：是否限制 commit message 长度/禁止含 `--amend`/`--no-verify`？Phase 4 禁止 `--no-verify`（绕过 hooks），message 非空即可。
