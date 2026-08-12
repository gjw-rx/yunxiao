## Why

当前聊天 Webview 的 CSS、HTML 和客户端脚本集中在 `src/chatPanel.ts` 的模板字符串中。随着流式回复、工具状态、审批、Diff、会话和命令菜单继续迭代，这种组织方式会放大视觉调整、状态维护和回归测试的成本。

将 Webview 迁移为独立的 React + TypeScript + Vite 前端，使 UI 可以按功能组件化，同时保持现有扩展宿主、Agent 事件和消息协议的行为兼容。

## What Changes

- 新增独立的 Webview 前端工程，使用 React、TypeScript 和 Vite 构建浏览器侧资源。
- 将聊天、会话、工具状态、审批、Diff、命令和文件引用等界面拆分为按功能组织的组件。
- 建立类型化的 Webview 消息桥接层，保持现有 `postMessage` / `onDidReceiveMessage` 协议兼容。
- 使用 VS Code 主题 CSS 变量和外部静态资源，支持浅色、深色与高对比主题，并收紧 Webview CSP。
- 更新扩展构建流程，使宿主 bundle 与 Webview bundle 分别产出并被安全注入。

## Capabilities

### New Capabilities

- `webview-ui-runtime`: 为聊天 Webview 提供独立构建、主题适配、消息桥接与组件化渲染能力。

### Modified Capabilities

- 无。

## Impact

- 主要影响 `src/chatPanel.ts`、`src/webview/`、`esbuild.js`、`package.json`、测试配置与 Webview 相关测试。
- 新增 React、React DOM、Vite 及其类型/测试依赖；不引入 Next.js、Material UI、Ant Design 或已废弃的 VS Code Webview UI Toolkit。
- 不修改 AgentLoop、工具审批、会话存储或前后端业务消息的语义；迁移期间应保持现有用户交互和扩展命令兼容。
