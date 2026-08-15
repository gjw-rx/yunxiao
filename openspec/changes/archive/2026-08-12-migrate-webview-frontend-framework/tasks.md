## 1. 构建基础与资源加载

- [x] 1.1 在根 `package.json` 增加 React、React DOM、Vite 及 Webview 组件测试依赖，并同步 lockfile。
- [x] 1.2 新增 `src/webview-ui/` 的 Vite 与 TypeScript 配置，构建固定名称的 `dist/webview-ui/index.js`、`index.css` 和 source map。
- [x] 1.3 更新 `compile`、`watch`、`package` 与 esbuild 入口，使宿主和 Webview 产物均被构建，移除 `src/webview/marked.js` 构建入口。
- [x] 1.4 将 `ChatViewProvider._getHtml()` 收敛为外部资源 shell，使用 `asWebviewUri()` 注入 Webview JS/CSS，并验证 `localResourceRoots` 覆盖产物目录。
- [x] 1.5 将 Webview CSP 收紧为仅允许本地必要资源，移除 `unsafe-inline`，并为资源 URI 与 CSP 编写宿主测试。

## 2. 协议与应用骨架

- [x] 2.1 定义 Host-to-Webview、Webview-to-Host 与共享界面状态的严格 TypeScript 判别联合类型。
- [x] 2.2 实现私有 VS Code API 桥接层，确保 `acquireVsCodeApi()` 仅调用一次，并提供类型化的发送与订阅接口。
- [x] 2.3 实现 React 根应用、全局 reducer 与 `webviewReady` 握手；宿主在握手后推送模型名和斜杠命令数据。
- [x] 2.4 将现有 `marked` 渲染能力迁移为 Webview bundle 内部依赖，保持现有安全渲染与文本转义行为。
- [x] 2.5 为协议映射、握手和关键 reducer 状态转换编写单元测试。

## 3. 分功能迁移界面

- [x] 3.1 迁移会话标题、历史下拉、新建/打开/重命名/删除会话和输入发送/停止交互。
- [x] 3.2 迁移用户与助手消息渲染、流式文本追加、思考/进度/计划状态、错误显示和 token 用量。
- [x] 3.3 迁移工具调用时间线、按 `call_id` 的 pending/running/success/error 转换与历史工具步骤恢复。
- [x] 3.4 迁移审批卡与 Diff 卡，验证批准、拒绝、始终允许和打开文件行为。
- [x] 3.5 迁移斜杠命令选择器、工作区文件引用与已选 Skill/文件展示。
- [x] 3.6 删除 `_getCss()`、`_getBodyHtml()`、`_getJs()` 及其遗留 DOM 事件代码，确保 `chatPanel.ts` 仅保留宿主职责。

## 4. 主题、无障碍与质量验证

- [x] 4.1 建立 Webview 语义化主题 token，将颜色、字体、边框和焦点样式映射至 `--vscode-*` 变量。
- [x] 4.2 为输入、按钮、下拉、审批和工具条目补齐语义标签、键盘操作和可见焦点。
- [ ] 4.3 在浅色、深色和高对比主题下手动验证聊天、工具、审批、Diff 和菜单的可读性与可操作性。
- [x] 4.4 运行 Webview 单元测试、现有 VS Code 测试、`npm run compile` 和生产打包，并在打包后的扩展中验证静态资源加载、会话恢复和流式交互。
