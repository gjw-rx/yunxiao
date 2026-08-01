# Implementation Tasks - Phase 1: Local Tool Calling

> 依赖顺序：类型契约 -> pathGuard -> 注册表/基类 -> read_file -> SSE handler -> 会话状态机 -> 工具结果协议 -> AIClient 扩展 -> 装配 -> mock 云端联调。
> 云端侧改动不在本任务清单，见 `docs/整体架构计划/Phase1改动计划.md`。

## 1. 共享类型契约（步骤 1.1）

- [x] 1.1 创建 `src/core/types.ts`，定义 `ExecutionSite`（`'local' | 'cloud'`）
- [x] 1.2 定义 `ToolCall`：`{ call_id, tool, args, site, require_approval }`
- [x] 1.3 定义 `ToolResult`：`{ call_id, status: 'success'|'error'|'cancelled', result, error?, metadata? }`
- [x] 1.4 定义 `ToolSchema`：`{ name, description, parameters(JSON Schema), permissions, site }`
- [x] 1.5 定义 `Permission` 枚举：`read | write | execute | destructive`
- [x] 1.6 创建 `src/core/errors.ts`，定义统一错误类型（`PathGuardError` / `ToolNotFoundError` / `ToolTimeoutError` / `ProtocolError`）与到用户友好提示的映射

## 2. 路径安全守卫（步骤 1.5）- CRITICAL

- [x] 2.1 创建 `src/tools/fs/pathGuard.ts`，实现工作区根解析（从 `vscode.workspace.workspaceFolders`）
- [x] 2.2 实现路径规范化（`path.normalize` + `path.resolve`），统一 POSIX/Windows 分隔符
- [x] 2.3 实现 `..` 越界检测：规范化后检查是否在某个工作区根下，越界抛 `PathGuardError`
- [x] 2.4 实现符号链接 `realpath` 解析，跟随链接后再次校验目标在工作区内；提供 `followSymlinks` 选项（默认 true）
- [x] 2.5 实现敏感文件检测（`.env`、`.git/`、`credentials.json`、私钥文件），返回 `sensitive` 标记
- [x] 2.6 无工作区打开时拒绝所有文件操作并返回明确错误
- [x] 2.7 编写单测 `src/test/tools/fs/pathGuard.test.ts`，覆盖：`../../../etc/passwd` 拦截、工作区外绝对路径拦截、`src/../src/x` 放行、Windows `\` 与盘符路径、符号链接越界、敏感文件标记、无工作区拒绝（AAA 模式）

## 3. 工具注册表与基类（步骤 1.3）

- [x] 3.1 创建 `src/tools/baseTool.ts`，定义抽象 `BaseTool`：`schema`、`validate(args)`、`execute(args, context) -> Promise<ToolResult>`、`permission`
- [x] 3.2 创建 `src/core/toolRegistry.ts`，实现 `register(schema, executor)`，重复名抛错
- [x] 3.3 实现 `lookup(name)`（未找到抛 `ToolNotFoundError`）与 `list()`（返回所有 schema）
- [x] 3.4 实现 `localSchemas()`：仅返回 `site === 'local'` 的 schema 数组，供会话创建上报
- [x] 3.5 创建 `src/core/toolRouter.ts`：收到 `tool_call` 时按 `site` 分发，`local` 走本地 executor，`cloud` 不本地执行
- [x] 3.6 编写单测 `src/test/core/toolRegistry.test.ts`：注册/查找/列举/重复注册拒绝/localSchemas 过滤

## 4. 首个本地工具 fs.read_file（步骤 1.4）

- [x] 4.1 创建 `src/tools/fs/readFile.ts`，继承 `BaseTool`，声明 schema（`fs.read_file`，permission `read`，site `local`，parameters 含 `path` 字符串）
- [x] 4.2 `validate`：校验 `path` 为非空字符串
- [x] 4.3 `execute`：经 pathGuard 解析路径，越界/敏感返回对应错误
- [x] 4.4 实现大小限制（默认 1MB，从配置 `yunxiaoAgent.maxFileSize` 读取，可缺省），超限返回错误不返回内容
- [x] 4.5 实现二进制检测（扩展名或内容 NUL 字节检测），二进制返回错误提示不返回文本
- [x] 4.6 实现敏感文件内容脱敏（API key / 密码 / token 正则替换为 `***`）并发出用户警告
- [x] 4.7 编写单测 `src/test/tools/fs/readFile.test.ts`：读小文本成功、文件不存在、超限、二进制、越界路径、敏感脱敏（AAA 模式）

## 5. SSE 事件处理器抽取（步骤 1.2）

- [x] 5.1 创建 `src/protocol/sseHandler.ts`，从 `aiClient.ts` 迁移 `handleSseBlock` 逻辑
- [x] 5.2 保留 `content` / `thought` / `tool_start` / `tool_end` 与 `{success:false}` 错误信封处理
- [x] 5.3 新增 `tool_call` 事件解析（按 `{type, data:{call_id, tool, args, site, require_approval}}`），分发到 `onToolCall`
- [x] 5.4 新增 `plan` / `progress` 事件解析与分发
- [x] 5.5 处理半包缓冲：按 `\n\n` 分隔事件、保留跨块 buffer（复用现有模式）
- [x] 5.6 编写单测 `src/test/protocol/sseHandler.test.ts`：各事件类型解析、半包拼接、错误信封、未知 type 忽略

## 6. 内部事件总线

- [x] 6.1 创建 `src/core/eventBus.ts`，实现 typed pub/sub（`on` / `emit` / `off`）
- [x] 6.2 定义事件类型：`content` / `thought` / `tool_call` / `tool_result` / `plan` / `progress` / `stream_end` / `error` / `tool_state_change`

## 7. 会话状态机（步骤 1.6）

- [x] 7.1 创建 `src/core/sessionManager.ts`，维护 `sessionId -> { pendingToolCalls: Map<call_id, state>, abortController, history }`
- [x] 7.2 实现 SSE 流生命周期：流开始创建/复用状态、流结束清理 streaming 标志
- [x] 7.3 实现工具调用生命周期：pending -> running -> success | error，状态变更经事件总线广播
- [x] 7.4 实现续流协调：收到 `tool_call` 且流结束后，执行工具 -> 回传结果 -> 触发新一轮 SSE 流（同一 session）
- [x] 7.5 实现取消：abort 当前 SSE 流 + 进行中工具；为 pending/running 工具发 `cancelled` 结果
- [x] 7.6 实现工具执行超时（默认 30s，可配置），超时 abort 并发 `error` 结果
- [x] 7.7 会话重置/新建时清理旧状态
- [x] 7.8 编写单测 `src/test/core/sessionManager.test.ts`：状态转换、续流多轮、取消发 cancelled、超时发 error（mock AIClient 与工具）

## 8. 工具结果回传协议（步骤 1.7）

- [x] 8.1 创建 `src/protocol/toolCallProtocol.ts`，封装 `POST /api/agent/invoke/tool_result`
- [x] 8.2 实现请求体构造（`session_id` / `call_id` / `status` / `result` / `error` / `metadata`）
- [x] 8.3 实现指数退避重试（最多 3 次），仅对网络/5xx 重试，4xx 不重试
- [x] 8.4 实现单次请求超时（默认 30s）-- 续流采用连接级重试 + AbortController 取消（无整流超时，避免截断长流）
- [x] 8.5 错误映射：网络错误、服务错误的友好提示
- [x] 8.6 编写单测 `src/test/protocol/toolCallProtocol.test.ts`：成功、重试成功、重试耗尽、4xx 不重试、超时（mock fetch）

## 9. AIClient 扩展（步骤 1.8）

- [x] 9.1 `streamMessage` 改用 `sseHandler` 解析，回调扩展 `onToolCall` / `onPlan` / `onProgress`，保持 `onContent` / `onEnd` / `onError` / `onThought` / `onToolStart` / `onToolEnd` 不变
- [x] 9.2 新增 `submitToolResult(body)` 方法，委托 `toolCallProtocol`
- [x] 9.3 `createSession` 增加可选 `local_tools` 参数，传入时附加到请求 body
- [x] 9.4 保持 `listAgents` / `getHistory` 不变
- [x] 9.5 验证无 `local_tools` 时 `createSession` 请求与原行为一致（向后兼容）-- `src/test/aiClient.test.ts` 覆盖

## 10. 装配与 UI 接入

- [x] 10.1 `src/extension.ts` 装配：实例化 toolRegistry / eventBus / sessionManager，注册 `fs.read_file`
- [x] 10.2 `chatPanel.ts` 接入 sessionManager：`sendMessage` 经 sessionManager 发起流；订阅事件总线更新 UI
- [x] 10.3 UI 最小展示工具调用状态：在消息流中以文本态显示 `pending/running/success/error`（精细卡片留 Phase 5）
- [x] 10.4 `package.json` 新增配置项 `yunxiaoAgent.maxFileSize`（默认 1048576）与 `yunxiaoAgent.toolTimeoutMs`（默认 30000）
- [x] 10.5 确保无 `local_tools` 的旧会话流程不回归（纯聊天仍正常）-- e2e 纯聊天轮次 + aiClient 向后兼容测试覆盖

## 11. Mock 云端与端到端验证

- [x] 11.1 编写本地 mock SSE 服务（`src/test/integration/e2e.test.ts` 内 MockCloud）：接收 `/message/stream`，先发 `tool_call(fs.read_file)`，接收 `/tool_result` 后发 `content` 总结并 end
- [x] 11.2 用 mock 跑通「读 hello.txt 并总结」端到端：tool_call -> 本地读取 -> 回传 -> 续流总结
- [x] 11.3 验证取消：流过程中停止 -> 发 cancelled 结果 -> 不卡死
- [x] 11.4 验证超时：mock 工具延迟 -> 超时发 error 结果
- [x] 11.5 跑全量单测，覆盖率 94.13% statements / 85.48% branch / 82.71% funcs（c8 实测，>= 80%）
- [x] 11.6 `npm run check-types` + `npm run lint` + `npm run compile` 通过
- [ ] 11.7 待云端就绪后切换真实云端联调，验证真实 `tool_call` / `/tool_result` 闭环（依赖 `Phase1改动计划.md` 完成）
