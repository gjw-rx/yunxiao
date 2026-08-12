## ADDED Requirements

### Requirement: 独立的 Webview UI 构建产物
系统 SHALL 使用 React、TypeScript 与 Vite 构建聊天 Webview 浏览器侧应用，并将可发布的 JavaScript 与 CSS 静态资源输出到扩展 `dist/webview-ui/` 目录。现有扩展宿主 SHALL 继续独立构建，且 `npm run compile`、`npm run watch` 与 `npm run package` SHALL 包含 Webview 构建步骤。

#### Scenario: 生产构建包含 Webview 资源
- **WHEN** 开发者执行 `npm run package`
- **THEN** 打包输入中包含 `dist/webview-ui/index.js` 与 `dist/webview-ui/index.css`，并且扩展宿主 bundle 仍可被加载

#### Scenario: 开发模式重建 Webview 资源
- **WHEN** 开发者执行 `npm run watch` 后修改 `src/webview-ui/` 下的源文件
- **THEN** Webview 静态产物被重新生成，无需依赖外部开发服务器

### Requirement: Webview 资源安全加载
`ChatViewProvider` SHALL 只生成包含根挂载节点、外部样式链接和外部模块脚本的最小 Webview HTML。资源 URL SHALL 由 `webview.asWebviewUri()` 生成，并受现有 `localResourceRoots` 约束。Webview CSP SHALL 以 `default-src 'none'` 为基础，只允许 `${webview.cspSource}` 的必需本地资源，且不得允许 `unsafe-inline`。

#### Scenario: Webview 加载构建后的资源
- **WHEN** 用户打开云效 Agent 对话面板
- **THEN** Webview 从扩展本地 `dist/webview-ui/` 加载 JavaScript 和 CSS，并将 React 应用挂载到根节点

#### Scenario: 内联执行被 CSP 拒绝
- **WHEN** Webview HTML 被生成
- **THEN** CSP 不包含 `unsafe-inline`，且页面不依赖内联脚本或内联样式才能运行

### Requirement: 类型化消息桥接与兼容行为
Webview 应用 SHALL 通过唯一私有的 `acquireVsCodeApi()` 实例与扩展宿主通信。该应用 SHALL 定义并校验 Host-to-Webview 与 Webview-to-Host 消息类型，并保持既有业务命令及字段兼容，包括 `sendMessage`、`stopStream`、`loadHistory`、`approvalDecision`、`openDiff`、`openFile`、`requestSlashCommands`、`requestWorkspaceFiles`、`renameSession`、`requestSessions`、`openSession`、`deleteSession` 及其现有响应事件。

#### Scenario: Webview 回传用户操作
- **WHEN** 用户在 React UI 中发送消息、停止流或作出审批决定
- **THEN** 应用向宿主发送与迁移前相同命令名和字段的 JSON 可序列化消息

#### Scenario: 宿主事件驱动 React 状态
- **WHEN** 宿主发送 `replyChunk`、`toolState`、`approvalRequest`、`diffResult`、`historyLoaded` 或 `sessionList`
- **THEN** 应用更新对应 React 状态和组件视图，而不通过全局 DOM 查询重建整个页面

#### Scenario: 应用完成挂载后请求初始数据
- **WHEN** React 应用首次挂载完成
- **THEN** 应用发送 `webviewReady`，宿主随后发送模型名和斜杠命令初始数据

### Requirement: 组件化聊天界面
Webview 应用 SHALL 将会话、聊天输入与消息、工具时间线、审批、Diff、斜杠命令和文件引用拆分为独立功能组件。组件 SHALL 保持迁移前的可见交互和状态转换，包括流式文本追加、工具状态更新、审批选择、打开 Diff、选择会话与引用文件。

#### Scenario: 工具状态在同一时间线条目中转换
- **WHEN** 应用收到同一 `call_id` 的 `toolCall` 和后续 `toolState`
- **THEN** 工具时间线中的同一组件从 pending 转换为运行、成功或失败状态，且不产生重复条目

#### Scenario: 历史会话恢复聊天和工具步骤
- **WHEN** 应用收到包含用户、助手和工具消息的 `historyLoaded`
- **THEN** 应用按消息顺序渲染聊天内容，并恢复其中的工具调用步骤和结果

### Requirement: VS Code 主题与无障碍适配
Webview UI SHALL 使用 VS Code CSS 主题变量定义语义化颜色、字体、边框和焦点样式，并在浅色、深色和高对比主题中保持可读且可操作。所有可交互控件 SHALL 支持键盘操作，具有可见焦点，并具有可访问名称。

#### Scenario: 主题切换后界面保持可读
- **WHEN** 用户在 VS Code 中切换浅色、深色或高对比主题
- **THEN** 聊天内容、输入框、按钮、工具状态、审批卡和 Diff 的前景/背景对比度仍可辨识

#### Scenario: 键盘用户完成基本聊天操作
- **WHEN** 用户仅使用键盘聚焦输入、发送/停止操作、命令菜单、会话菜单和审批按钮
- **THEN** 每个控件可获得焦点、具有可访问名称，并可执行对应操作
