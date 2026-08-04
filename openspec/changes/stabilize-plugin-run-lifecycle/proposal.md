## Why

当前 VSCode 插件的编译范围会意外包含 vendored OpenCode 源码，导致类型检查无法作为可靠门禁；同时一次用户输入的流式运行仅按 `sessionId` 保存内存状态，旧连接回调可能污染后续运行，且完成、取消、失败和断线会收敛为相同的 `stream_end` 表现。`code.edit` 在用户审批期间也没有再次验证目标文件版本，可能将已过期的 diff 应用到用户刚修改的文件。

这些缺陷应在引入持久 Run Harness 前先修复，否则后续的运行重放、恢复和时间线会建立在不可靠的本地状态机与测试门禁之上。

## What Changes

- 收紧插件 TypeScript 工程范围，只编译 `src` 下的插件源码和测试，排除 vendored OpenCode、文档及生成工件，并恢复 `check-types`、lint 和现有测试门禁。
- 为每次本地用户运行分配单调递增的 generation；所有 SSE、工具执行及续流回调必须携带并校验 generation，旧运行不得修改新运行状态或触发新的工具调用。
- 将运行终态显式区分为 `completed`、`cancelled`、`failed` 和 `disconnected`，不再依赖统一的 `stream_end` 推断结果。
- 识别 `/tool_result` 返回的 `application/json` duplicate acknowledgement，将其作为已接纳结果处理，而不是当作 SSE 正常完成或解析错误。
- 在 `code.edit` 展示 diff 并等待审批后、真正写入前再次读取并校验文件版本；版本变化时拒绝应用并保留当前文件。
- 增加覆盖编译范围、过期回调、重复结果 acknowledgement、各类终态和审批期间并发编辑的回归测试。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `session-orchestration`: 增加单次运行 generation 隔离、过期回调丢弃和明确终态语义。
- `tool-call-protocol`: 增加 tool-result duplicate JSON acknowledgement 的内容类型与客户端处理要求。
- `code-edit`: 明确文件版本必须贯穿读取、diff 预览、审批和最终写入，并在审批后执行最后一次版本校验。

## Impact

- 插件构建配置：`tsconfig.json`、npm scripts 与测试发现范围。
- 插件运行时：`SessionManager`、SSE 回调适配、`AIClient`/tool-result 续流协议及事件类型。
- 本地编辑工具：`code.edit` 的版本捕获、审批后复核和冲突结果。
- 测试：TypeScript 编译门禁、协议单元测试、SessionManager 状态机测试和 `code.edit` 并发修改测试。
- 云端 API 保持兼容；本 change 不引入持久 Run 表、v2 API、后台 worker 或断线重放。
