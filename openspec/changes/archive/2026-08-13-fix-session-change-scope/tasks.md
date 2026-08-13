## 1. Session baseline and aggregation

- [x] 1.1 Persist an eligible-workspace baseline before the first Agent run in a session.
- [x] 1.2 Refresh one session-level change set from the baseline and current workspace after each final reply.
- [x] 1.3 Refresh the cumulative set after rollback and remove it with its session.

## 2. Integration and verification

- [x] 2.1 Wire AgentLoop and existing review references to the session-level change set.
- [x] 2.2 Add tests covering terminal-equivalent workspace edits, cumulative changes, and baseline exclusion.
- [x] 2.3 Run compilation, relevant tests, and strict OpenSpec validation.

> 验证结果：`npm run compile`、`npm run test:webview` 与严格 OpenSpec 校验通过。`npm test` 有 589 项通过；两个既有 `searchFiles` 用例因环境无法启动 `rg` 而失败。
