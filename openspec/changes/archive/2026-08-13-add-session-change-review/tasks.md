## 1. Change-set persistence

- [x] 1.1 Implement the session-isolated change journal, snapshot model, summary APIs, and lifecycle cleanup.
- [x] 1.2 Inject a change recorder into managed write tools and remove automatic `code_edit` editor preview.
- [x] 1.3 Bind a completed turn's change set to its final assistant history message and prune it on rollback/session deletion.

## 2. Host and protocol integration

- [x] 2.1 Add typed host/Webview messages and ChatPanel handlers for reply change actions and review data requests.
- [x] 2.2 Add a dedicated change-review WebviewPanel with bounded file-detail payloads.

## 3. Webview experience

- [x] 3.1 Render a code-change action after every final assistant reply and restore it from session history.
- [x] 3.2 Implement the dark-theme review summary and before/after file diff views.
- [x] 3.3 Remove obsolete inline DiffCard event/state rendering for `code_edit` changes.

## 4. Verification

- [x] 4.1 Add unit tests for change aggregation, cleanup, and automatic preview removal.
- [x] 4.2 Add reducer/protocol tests for reply actions and review-page data flow.
- [x] 4.3 Run type checking, linting, and relevant test suites; update task status.

> 验证结果：`npm run compile`、`npm run test:webview` 与 OpenSpec 严格校验通过；`npm test` 新增用例通过，但现有 `searchFiles` 的两项用例因当前环境无法启动 `rg`（EPERM）失败。
