## Why

Phase 1-5 已打通本地工具调用、审批、代码智能、终端/Git 以及 UI，但异常路径仍分散在各工具和会话逻辑中：敏感请求、超大或敏感结果、取消、超时、网络中断和并发冲突缺少统一边界。Phase 6 需要把这些边界收敛为可验证的安全与可靠性契约，才能支持生产部署，并让云端 Agent 在收到失败、取消或裁剪后的结果时稳定地继续推理。

## What Changes

- 新增统一安全审计入口，在本地工具执行前检查路径、命令、敏感文件、结果规模和并发修改风险。
- 扩展会话状态管理，支持取消、超时清理和受声明约束的并行 tool_call。
- 统一错误分类、重试与续流恢复，区分可重试故障和不可重试故障，并向 Agent 返回用户可理解的结果。
- 为所有本地工具增加统一结果裁剪、二进制跳过、敏感信息脱敏和可选 token 预警。
- 固化本地工具权限矩阵及二次确认语义，避免权限判断散落在单个工具实现中。
- 更新云端 Agent 的结果消费、续流恢复、取消/并发兼容、系统提示和回归测试契约；不改变本地工具逐个上报和自动包装机制。

## Capabilities

### New Capabilities

- `security-boundary`: 在工具执行前统一执行安全审计，并在结果返回前执行裁剪与脱敏。
- `reliability-recovery`: 为取消、超时、网络中断、并发冲突和工具失败提供统一状态与恢复语义。

### Modified Capabilities

- `tool-call-protocol`: 明确取消、重试、裁剪结果、并行调用及续流恢复的协议行为。
- `session-orchestration`: 增加取消、超时清理、并行调用和恢复状态约束。
- `file-tools`: 统一大文件、二进制内容、敏感文件和并发修改的边界行为。
- `terminal-tools`: 统一超时、危险命令失败和超大输出的结果语义。
- `approval-gateway`: 明确权限矩阵与破坏性操作二次确认的统一判定。

## Impact

- 本地插件：`src/core/securityAudit.ts`、`src/core/sessionManager.ts`、`src/core/errors.ts`、`src/tools/baseTool.ts`、`src/config/defaultTools.ts` 及相关工具/协议测试。
- 云端 Agent：本地工具结果注入与续流服务、SSE/tool_result 处理、Agent 系统提示和 `tests/api/agent/` 回归用例。
- 对外协议：沿用现有 `tool_call` 和 `/api/agent/invoke/tool_result` 信封，新增/明确状态与 metadata 语义；不引入新的传输协议。
