## Why

插件重启、断线或超时发生在本地副作用工具执行期间时，现有 SessionManager 无法区分“尚未执行”和“已经开始但结果丢失”。对同一工具调用盲目重放可能重复写文件、运行命令或执行破坏性操作，因此需要在本地持久化最小执行回执，并以安全的未知状态阻断自动重放。

## What Changes

- 在工作区状态中持久化以 Run ID 与 tool call ID 标识的本地工具执行 journal。
- 在 write、execute、destructive 工具开始前写入 `started` 回执，并在取得最终工具结果后写入终态回执与结果摘要。
- 对已存在的终态回执复用结果；对遗留的 `started` 回执返回不可重试的 `unknown` 结果，且不调用工具实现。
- 让会话恢复路径将 `unknown` 结果提交给云端，保留人工处置空间而不自动重放副作用工具。

## Capabilities

### New Capabilities

- `local-tool-execution-journal`: 为非幂等本地工具提供持久化执行回执、终态结果复用与未知状态防重放语义。

### Modified Capabilities

- `local-tool-registry`: 本地工具路由在执行副作用工具前后必须接入 execution journal。

## Impact

影响 `src/core/toolRouter.ts`、`src/core/sessionManager.ts`、新增 journal 存储模块及其单元测试。存储继续使用 VS Code `workspaceState`，不新增云端 API、数据库或自动恢复执行行为。
