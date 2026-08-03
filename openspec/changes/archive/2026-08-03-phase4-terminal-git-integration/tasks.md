# Implementation Tasks - Phase 4: Terminal & Git Integration

> 依赖顺序：配置与依赖 -> ShellWhitelist -> 终端执行工具 -> Git 客户�?-> Git 工具�?-> 装配 -> UI 接入 -> mock 云端联调�?> 云端侧改动不在本任务清单，见 `docs/整体架构计划/Phase4改动计划.md`�?> 架构步骤编号对齐 `docs/04-架构演进规划.md` Phase 4�?.24-4.27）�?
## 1. 依赖与配�?
- [x] 1.1 `package.json` 新增依赖 `simple-git`（dependencies，锁定版本）
- [x] 1.2 `package.json` contributes.configuration 新增 `yunxiaoAgent.shellWhitelist`（type `array` of `string`，默�?`["npm test","npm run lint","npm run build","npm run check","git status","git diff","git log","git branch","node -v","npm -v","tsc --noEmit","python -m pytest","go test","cargo test"]`，描述「终端自动放行的安全命令前缀列表」）
- [x] 1.3 `package.json` contributes.configuration 新增 `yunxiaoAgent.terminalTimeoutMs`（type `number`，默�?`300000`，描述「终端命令执行超时（毫秒），默认 5 分钟」）
- [x] 1.4 `package.json` contributes.configuration 新增 `yunxiaoAgent.terminalOutputLimit`（type `number`，默�?`10000`，描述「终端输出截断上限（字符），保留尾部」）
- [x] 1.5 `npm install` 安装 `simple-git`，验�?`npm run check-types` + `npm run lint` 通过 -> verify: 无类�?lint 报错

## 2. 命令白名�?危险拦截器（步骤 4.25�?
- [x] 1 创建 `src/tools/terminal/shellWhitelist.ts`，定�?`CommandCategory` 类型（`'dangerous' | 'whitelisted' | 'unknown'`）与 `ClassifyResult`（`{ category, reason? }`�?- [ ] 2.2 实现 `ShellWhitelist` 类，构造接�?`whitelist: string[]`（从配置读取�?- [ ] 2.3 实现 `classify(command: string): ClassifyResult`：先�?dangerous（任一命中即返�?`{ category: 'dangerous', reason: '<pattern>' }`），再查 whitelisted（前缀匹配），最�?`{ category: 'unknown' }`
- [x] 4 硬编码危险模式正则数组（大小写不敏感）：`rm -rf`/`rm -fr`、` > `/`>>`、`|`、`;`、`&&`、`||`、`curl|sh`/`wget|sh`/`curl|bash`、`chmod 777`、`chown`、`sudo`、fork bomb `:()`、`mkfs`、`dd if=`、`git push --force`、`git reset --hard`
- [x] 5 白名单前缀匹配：命令去除前导空格后，以白名单条目为前缀（如 `npm test -- --grep foo` 匹配 `npm test`�?- [ ] 2.6 编写单测 `src/test/tools/terminal/shellWhitelist.test.ts`：危险命令拦截（rm -rf、含 `;`/`|`/`&&` 的链式命令、curl|sh）、白名单前缀匹配（含参数）、unknown 分类、dangerous 优先�?whitelisted（`npm test && rm -rf` �?dangerous）、白名单配置覆盖默认、大小写不敏感（AAA 模式�?
## 3. 终端执行工具（步�?4.24�?
- [x] 1 创建 `src/tools/terminal/terminalExec.ts`，继�?`BaseTool`，schema：`terminal.exec`、permission `execute`、site `local`、parameters `{ command: string (required), cwd?: string, timeoutMs?: number }`
- [x] 2 设置 `handlesOwnApproval = true`；构造注�?`ApprovalGateway` �?`ShellWhitelist`（`TerminalExecToolOptions` 接口�?- [ ] 3.3 `validate`：`command` 为非空字符串（`requireStringArg`）；`cwd` 若提供则为非空字符串；`timeoutMs` 若提供则�?>= 1000 的整�?- [ ] 3.4 `execute` 流程：调 `shellWhitelist.classify(command)`�?  - `dangerous` -> 返回 `{ status: 'cancelled', error: '危险命令已被拦截: <reason>' }`，不弹审批不 spawn
  - `whitelisted` -> 跳过审批，直接执�?  - `unknown` -> �?`approval.requestApproval('terminal.exec', summary, sessionId)`；`deny` 返回 cancelled，`allow`/`always` 执行
- [x] 5 审批摘要含完整命令（`terminal.exec 将执行：\n<command>`�?- [ ] 3.6 命令执行：按 `process.platform` �?shell（Windows: `cmd.exe /c` �?`process.env.ComSpec`；Unix: `/bin/sh -c` �?`process.env.SHELL`），`child_process.spawn(shell, [flag, command], { cwd })`
- [x] 7 捕获 stdout/stderr（监�?`data` 事件累加）；退出时收集 exitCode
- [x] 8 超时：`setTimeout(timeoutMs)` -> `proc.kill('SIGTERM')`�?s 宽限�?`SIGKILL`，返�?`{ status: 'error', error: '命令执行超时�?N>s�? }`（含 kill 前已捕获�?partial 输出�?- [ ] 3.9 取消：监�?`ToolContext` 传入的取消信号（�?AbortSignal），触发�?`proc.kill()` 返回 `{ status: 'cancelled', error: '用户取消执行' }`
- [x] 10 输出截断：stdout/stderr 各截断至 `terminalOutputLimit`（保留尾部），超限标�?`{ truncated: true, totalChars: N }`
- [x] 11 返回结构：成�?`{ status: 'success', result: JSON.stringify({ stdout, stderr, exitCode, truncated }), metadata: { exitCode, duration_ms } }`；exitCode �?0 仍为 success（结果含 exitCode�?- [ ] 3.12 `cwd` 解析：默�?`workspaceRoots[0]`；提供时相对 workspaceRoots[0] 解析（用 pathGuard �?`resolveWithinRoots` 防越界）
- [x] 13 编写单测 `src/test/tools/terminal/terminalExec.test.ts`：成功执行（mock spawn）、exitCode �?0、危险命令拦截不 spawn、白名单免审批、unknown 审批允许/拒绝、超�?kill、输出截断保留尾部、空 command 校验拒绝、cwd 解析（mock ApprovalGateway �?ShellWhitelist，AAA 模式�?
## 4. Git 客户端基础（步�?4.26�?
- [x] 1 创建 `src/tools/git/gitClient.ts`，封�?`simple-git` 实例；提�?`createGitClient(workspaceRoot: string)` 工厂，返�?`SimpleGit` 实例（或封装薄层�?- [ ] 4.2 提供 `isGitRepo(workspaceRoot: string): Promise<boolean>` 辅助（`simpleGit(root).checkIsRepo()`�?- [ ] 4.3 编写单测 `src/test/tools/git/gitClient.test.ts`：createGitClient 返回有效实例、isGitRepo true/false（mock simple-git，AAA�?
## 5. Git 工具�?- status/diff（步�?4.27 + read 工具�?
- [x] 1 创建 `src/tools/git/gitStatus.ts`，继�?`BaseTool`，schema：`git.status`、permission `read`、site `local`、parameters `{}`（无参）
- [x] 2 `execute`：从 `workspaceRoots[0]` 创建 git client -> `checkIsRepo()`（非 repo 返回 error�?> `.status()` -> 映射�?`{ currentBranch, trackingBranch, staged: [{file, index}], unstaged: [{file, workingDir}], untracked: [file] }`
- [x] 3 文件列表�?200 条截断，�?`{ truncated: true, total: N }`
- [x] 4 返回 `result` �?JSON 字符串，`metadata: { duration_ms }`
- [x] 5 编写单测 `src/test/tools/git/gitStatus.test.ts`：clean 工作区、混合变更、非 repo 错误、截断逻辑（mock simple-git status，AAA�?
- [x] 6 创建 `src/tools/git/gitDiff.ts`，继�?`BaseTool`，schema：`git.diff`、permission `read`、site `local`、parameters `{ mode?: 'unstaged'|'staged'|'ref', base?: string }`（mode 默认 `unstaged`，`ref` 模式需 `base`�?- [ ] 5.7 `execute`：`unstaged` -> `.diff()`；`staged` -> `.diff(['--cached'])`；`ref` -> `.diff([base])`
- [x] 8 diff 输出截断�?10000 字符（按文件分组保留前若�?hunk），附截断标�?- [ ] 5.9 `validate`：`mode` 若提供为枚举值；`ref` 模式�?`base` 必填
- [x] 10 编写单测 `src/test/tools/git/gitDiff.test.ts`：unstaged/staged/ref 三模式、截断、ref 模式�?base 校验拒绝、非 repo 错误（mock simple-git diff，AAA�?
## 6. Git 工具�?- commit/branch/stash（write 工具�?
- [x] 1 创建 `src/tools/git/gitCommit.ts`，继�?`BaseTool`，schema：`git.commit`、permission `write`、site `local`、parameters `{ message: string (required) }`
- [x] 2 `validate`：`message` 非空字符串；禁止 `--no-verify`/`--amend`（正则检测，命中�?`ToolValidationError`�?- [ ] 6.3 `execute`：非 repo 检�?-> `.commit(message)` -> 返回 `{ status: 'success', result: '已提�? <sha>', metadata: { sha, duration_ms } }`；无暂存变更返回 error
- [x] 4 路由层统一审批（非 handlesOwnApproval），拒绝时返�?cancelled
- [x] 5 编写单测 `src/test/tools/git/gitCommit.test.ts`：提交成功、空 message 拒绝�?-no-verify 拒绝�?-amend 拒绝、无暂存变更 error、非 repo 错误（mock simple-git，AAA�?
- [x] 6 创建 `src/tools/git/gitBranch.ts`，继�?`BaseTool`，schema：`git.branch`、permission `write`、site `local`、parameters `{ action?: 'list'|'create'|'checkout', name?: string }`（action 默认 `list`；create/checkout 需 `name`�?- [ ] 6.7 `execute`：`list` -> `.branch()` 返回分支列表（标�?current）；`create` -> `.checkoutLocalBranch(name)`；`checkout` -> `.checkout(name)`
- [x] 8 `validate`：`action` 若提供为枚举值；create/checkout �?`name` 必填
- [x] 9 checkout 失败（有未提交更改可能被覆盖）捕�?simple-git 错误返回友好 error
- [x] 10 编写单测 `src/test/tools/git/gitBranch.test.ts`：list/create/checkout、create �?name 拒绝、checkout 冲突 error、非 repo 错误（mock simple-git，AAA�?
- [x] 11 创建 `src/tools/git/gitStash.ts`，继�?`BaseTool`，schema：`git.stash`、permission `write`、site `local`、parameters `{ action?: 'push'|'pop'|'list', message?: string }`（action 默认 `push`�?- [ ] 6.12 `execute`：`push` -> `.stash(['push', '-m', message])`（message 可选）；`pop` -> `.stash(['pop'])`；`list` -> `.stash(['list'])`
- [x] 13 `validate`：`action` 若提供为枚举�?- [ ] 6.14 pop �?stash 条目返回 error
- [x] 15 编写单测 `src/test/tools/git/gitStash.test.ts`：push/pop/list、pop �?stash error、非 repo 错误（mock simple-git，AAA�?
## 7. 装配（extension.ts�?
- [x] 1 `src/extension.ts` 注册全部新工具到 `ToolRegistry`：`terminal.exec`、`git.status`、`git.diff`、`git.commit`、`git.branch`、`git.stash`
- [x] 2 构�?`ShellWhitelist`（从配置读取 `shellWhitelist`），构�?`ApprovalGateway`（复用现有实例），注�?`TerminalExecTool`
- [x] 3 `git.*` 工具共享同一 `simpleGit(workspaceRoot)` 实例（或各自通过 `createGitClient` 构造）
- [x] 4 验证�?`local_tools` 旧会话流程不回归（纯聊天 + Phase 1-3 工具仍正常）-> verify: e2e 纯聊�?+ read_file/write_file/get_diagnostics 轮次通过

## 8. UI 最小接入（chatPanel.ts�?
- [x] 1 `chatPanel.ts` 补全新工具的工具状态卡片展示（terminal.exec/git.status/git.diff/git.commit/git.branch/git.stash �?pending/running/success/error�?- [ ] 8.2 终端执行结果可选在消息流展示摘要（文本态，如「exitCode: 0, stdout: <�?200 �?」；git status 摘要如「main 分支�? staged, 2 unstaged」）
- [x] 3 验证工具状态卡片正确显示新工具执行状�?-> verify: 手动触发 terminal.exec 见状态更�?
## 9. Mock 云端与端到端验证

- [x] 1 扩展 `src/test/integration/e2e.test.ts` �?MockCloud：支持下�?`terminal.exec` / `git.status` / `git.diff` �?`tool_call` 并接�?`/tool_result`
- [x] 2 e2e 场景「跑一下测试，如果失败就修复」：terminal.exec 运行 `npm test`（失败）-> 解析 stderr -> code.edit 修复 -> terminal.exec 再运�?`npm test`（通过�?- [ ] 9.3 e2e 场景「查看当前变更并提交」：git.status 查看变更 -> git.diff 查看 diff -> git.commit 提交（审批通过�?- [ ] 9.4 e2e 场景「危险命令拦截」：terminal.exec 收到 `rm -rf /` -> 返回 cancelled -> Agent 改换策略
- [x] 5 e2e 场景「白名单免审批」：terminal.exec 收到 `npm run lint`（白名单�?> 直接执行无审批弹�?- [ ] 9.6 验证输出截断：terminal.exec 产生大输�?-> 结果�?truncated 标记
- [x] 7 `npm run check-types` + `npm run lint` + `npm run compile` 通过
- [x] 8 待云端就绪后切换真实云端联调，验证真�?`tool_call`（含终端/Git 工具�? `/tool_result` 闭环（依�?`Phase4改动计划.md` 完成�?