## Context

`ChatViewProvider` 当前在 `src/chatPanel.ts` 中通过 `_getCss()`、`_getBodyHtml()` 与 `_getJs()` 生成完整 Webview。该实现同时承担扩展宿主消息路由、HTML 组装、样式、DOM 查询、交互状态和视图渲染，已覆盖流式消息、工具时间线、审批、Diff、会话历史、斜杠命令和文件引用。

迁移必须保留 VS Code Webview 的边界：扩展宿主通过 `webview.postMessage()` 向浏览器侧发送 JSON 可序列化事件，浏览器侧通过 `acquireVsCodeApi()` 获得的实例回传消息。现有 Node.js 扩展宿主继续使用 esbuild；本变更不将整个扩展转换为 Web Extension。

## Goals / Non-Goals

**Goals:**

- 将浏览器侧 UI 从 `chatPanel.ts` 中移出，形成独立、可组件化和可测试的前端工程。
- 保持现有用户操作及业务消息语义兼容，包括会话、流式输出、取消、工具状态、审批、Diff、文件选择、历史和斜杠命令。
- 使用 VS Code 主题变量、外部静态资源和严格 CSP，使 UI 在浅色、深色和高对比主题下可用。
- 将 Webview 构建产物稳定地纳入现有 `npm run compile`、`npm run watch` 和 `npm run package` 流程。

**Non-Goals:**

- 不重写 AgentLoop、LocalSessionManager、工具、审批或会话持久化。
- 不在本次迁移中改变产品交互、增加新功能或完成完整视觉重设计。
- 不采用 Next.js、服务器端渲染、远程 CDN、Material UI、Ant Design 或已废弃的 VS Code Webview UI Toolkit。
- 不承诺 Web Extension / `vscode.dev` 兼容；现有扩展宿主依赖 Node.js API。

## Decisions

### 1. Webview 使用 React + TypeScript + Vite

在 `src/webview-ui/` 创建 React 前端，使用 Vite 只构建浏览器侧资源；扩展宿主仍由 `esbuild.js` 构建为 CommonJS。

React 适合当前已有多个独立交互区域的聊天界面，可用成熟的组件、状态和测试生态。Vite 负责浏览器 bundle、CSS 提取、开发 watch 和 source map，不再用 Node 平台的 esbuild bundle 承担 Webview 应用构建。

- **备选：Preact**。体积更小，但当前界面的长期迭代收益主要来自组件边界而非数 KB 运行时节省，且 React 生态兼容性更稳妥。
- **备选：Svelte 或 Vue**。均可实现目标，但项目没有既有技术基础，无法抵消迁移与维护成本。
- **备选：保留原生 DOM**。初始依赖最少，但无法解决视图、状态和事件集中在单一模板中的维护问题。

### 2. 使用固定名称的本地静态产物

Vite 构建输出至 `dist/webview-ui/`，产出固定入口文件 `index.js` 与 `index.css`，不依赖开发服务器、CDN 或运行时读取 manifest。`ChatViewProvider._getHtml()` 只输出最小 HTML shell，并通过 `webview.asWebviewUri()` 注入这两个资源 URI。

固定产物名避免宿主在运行时解析 Vite manifest；`dist` 已在 `localResourceRoots` 内，因而不扩大本地资源权限。原有 `src/webview/marked.js` 应被移除，改由 Webview bundle 直接导入现有 `marked` 依赖。

### 3. 维持宿主消息协议，新增类型化桥接层

在 `src/webview-ui/protocol.ts` 定义 Host-to-Webview 和 Webview-to-Host 的判别联合类型；`bridge/vscode.ts` 在模块作用域仅调用一次 `acquireVsCodeApi()`，并提供 `post()` 与 `subscribe()`。

React `App` 通过一个 reducer 消费宿主事件，按 `call_id` 维护工具、审批和 Diff 状态。现有命令名与字段保持不变；仅新增 `webviewReady` 握手消息，使宿主在 UI 挂载后发送模型名和斜杠命令初始数据。

该边界允许宿主继续使用现有的 `_handleMessage()` 和 `_forwardEvent()`，只将 HTML/DOM 责任移至 Webview 应用。

### 4. 按用户可见功能拆分组件，不引入完整组件库

组件按 `chat`、`session`、`tools`、`approval`、`diff`、`commands`、`files` 和 `shared` 组织；每个组件只接收显示所需的状态和回调。共享样式由 `styles/tokens.css` 将语义 token 映射到 `--vscode-*` 变量，功能样式使用 CSS Modules 或同目录拆分 CSS。

初始版本使用语义化原生控件和 `@vscode/codicons`，不引入重型组件库。这样能维持 VS Code 原生观感，并避免组件库自己的主题体系覆盖编辑器主题。

### 5. 外部资源 CSP 与主题/无障碍为交付条件

Webview CSP 使用 `default-src 'none'`，仅允许 `${webview.cspSource}` 加载脚本、样式和本地图片；迁移后不得保留 `unsafe-inline`。用户内容继续走既有 Markdown 渲染和转义边界，不能将 `acquireVsCodeApi()` 暴露到全局对象。

所有组件必须使用 VS Code 主题变量并在 `vscode-light`、`vscode-dark`、`vscode-high-contrast` 下验证。可交互元素须有可见焦点、语义标签和键盘可操作性。

## Risks / Trade-offs

- [一次迁移同时改变视图与状态会导致流式、审批或工具时间线回归] → 首先冻结现有消息契约，按功能分阶段迁移，并在每阶段运行宿主回归测试与 Webview 组件测试。
- [Vite 资源命名或路径配置错误导致发布后的 Webview 空白] → 使用固定产物名、`asWebviewUri()`、最小 CSP，并在 `.vsix` 包装后的 VS Code 实例中验证。
- [React 增加安装包体积和启动开销] → 仅构建一个本地入口，避免大型组件库和运行时网络依赖；将聊天历史的大量渲染优化留作后续独立变更。
- [主题变量不足以实现当前视觉细节] → 语义 token 可带有 VS Code 变量回退值，但不得以固定浅色值替代整个主题系统。
- [当前测试依赖生成的 HTML 文本] → 保留对宿主 HTML shell 和资源 URI 的最小测试，将行为测试转移到协议、reducer 与组件层。

## Migration Plan

1. 新增依赖和 Vite 配置，先构建一个能挂载的空 React Webview，并验证开发、watch、生产打包均输出本地资源。
2. 建立类型化协议、桥接层和 `webviewReady` 握手；保持宿主消息名称与字段不变。
3. 依次迁移会话与输入、消息流、工具时间线、审批/Diff、命令与文件引用；每一步以现有行为为验收基线。
4. 移除 `_getCss()`、`_getBodyHtml()`、`_getJs()` 和 `src/webview/marked.js`，将 `_getHtml()` 收敛为资源 shell，并收紧 CSP。
5. 验证三种主题、键盘操作、Webview 重建/隐藏恢复、打包 `.vsix` 后资源加载与现有测试套件。

如出现无法快速定位的行为回归，可恢复由旧 `_getHtml()` 生成的静态 UI，同时保留构建配置和协议测试；该回退不触碰 Agent 或数据层。

## Open Questions

- 迁移验收前是否需要同步引入独立的视觉规范（间距、排版、状态色和动效），还是将其作为后续变更？默认仅保证现有功能与主题适配。
- Webview 组件测试采用 Vitest + Testing Library，还是仅以 reducer/协议单测和 VS Code 集成测试开始？默认采用前者，以覆盖用户交互。
