## MODIFIED Requirements

### Requirement: 类型化消息桥接与兼容行为
Webview 应用 SHALL 通过唯一私有的 `acquireVsCodeApi()` 实例与扩展宿主通信。该应用 SHALL 定义并校验 Host-to-Webview 与 Webview-to-Host 消息类型，并保持既有业务命令及字段兼容，包括 `sendMessage`、`stopStream`、`loadHistory`、`approvalDecision`、`openDiff`、`openFile`、`requestSlashCommands`、`requestWorkspaceFiles`、`renameSession`、`requestSessions`、`openSession`、`deleteSession` 及其现有响应事件。应用首次挂载时 MUST 先发送 `webviewReady` 并等待新增的运行时就绪状态；只有状态为 `ready` 时，应用才可请求初始模型和斜杠命令数据并创建首个会话。

#### Scenario: Webview 回传用户操作
- **WHEN** 应用在运行时就绪后发送消息、停止流或作出审批决定
- **THEN** 应用向宿主发送与迁移前相同命令名和字段的 JSON 可序列化消息

#### Scenario: 宿主事件驱动 React 状态
- **WHEN** 应用收到 `replyChunk`、`toolState`、`approvalRequest`、`diffResult`、`historyLoaded` 或 `sessionList`
- **THEN** 应用更新对应 React 状态和组件视图，而不通过全局 DOM 查询重建整个页面

#### Scenario: 应用完成挂载后请求初始数据
- **WHEN** React 应用首次挂载完成且宿主报告运行时为 `ready`
- **THEN** 应用发送 `webviewReady`，随后请求模型名和斜杠命令初始数据并创建首个会话

#### Scenario: 应用在运行时未就绪时挂载
- **WHEN** React 应用首次挂载完成且宿主报告运行时为 `initializing` 或 `failed`
- **THEN** 应用只渲染对应启动状态，不请求业务初始数据，也不创建会话
