## 1. Execution journal

- [x] 1.1 新增 workspaceState 持久化的有界 ToolExecutionJournal，并覆盖 started、终态和 unknown 回执语义。
- [x] 1.2 为 ToolContext 提供可选 Run ID，并在恢复订阅的工具调用中传递该范围标识。

## 2. Router integration

- [x] 2.1 在 ToolRouter 的非只读执行路径接入回执查询、started 写入、终态保存和未知状态阻断。
- [x] 2.2 确保取消或超时后未确认的工具调用保留 started 回执，禁止迟到结果将其标为终态。

## 3. Verification

- [x] 3.1 增加 journal 与 router 的结果复用、unknown、防参数持久化和超时回归测试。
- [x] 3.2 运行 TypeScript 编译、定向测试与 OpenSpec strict validate。
