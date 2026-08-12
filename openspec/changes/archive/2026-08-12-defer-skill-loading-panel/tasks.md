## 1. 运行时就绪协议与加载界面

- [x] 1.1 在 `src/webview-ui/protocol.ts`、状态映射和 reducer 中定义并处理 `initializing`、`ready`、`failed` 运行时状态消息。
- [x] 1.2 在 `src/chatPanel.ts` 中维护运行时状态，在 `webviewReady` 时回传当前状态，并在状态变更时推送给已解析的聊天 Webview。
- [x] 1.3 在 `src/webview-ui/App.tsx` 及样式中实现主题适配、可访问的居中图标加载/失败视图；仅在首次收到 `ready` 后请求初始数据并创建会话。
- [x] 1.4 为 Host 未就绪阶段的创建会话、发送消息、读取历史和请求斜杠命令添加消息守卫与中文可定位日志。

## 2. 非阻塞 Skill 初始化

- [x] 2.1 调整 `src/extension.ts` 装配顺序，使侧栏 Provider 与打开命令在首次 Skill 同步前注册，且不会向未装配完成的会话依赖暴露业务操作。
- [x] 2.2 将首次 `syncSkills()` 改为受控后台任务，复用现有串行同步队列，并在运行时与同步均成功后发布 ready、刷新斜杠命令。
- [x] 2.3 捕获首次后台同步异常，记录开始、完成、失败、耗时日志，并向当前及后续 Webview 发布 failed 状态。
- [x] 2.4 验证来源切换、目录保存和 ZIP 安装仍与首次同步串行执行，完成后返回最终 Skill 快照并刷新斜杠命令。

## 3. 测试与验证

- [x] 3.1 扩展 `src/test/chatPanel.test.ts`，覆盖初始化、就绪和失败状态推送，以及未就绪消息不会调用会话或 Skill 依赖。
- [x] 3.2 扩展 `src/webview-ui/test/`，覆盖加载页渲染、ready 后仅一次的初始请求、failed 状态不创建会话和状态映射。
- [x] 3.3 扩展与 Skill 同步调度相关的扩展测试，覆盖 Provider 先注册、首次后台同步完成后刷新，以及与设置重载的串行行为。
- [ ] 3.4 执行 `npm run compile`、`npm run test:webview` 和 `npm test`，并手动在大量 Skill 文件环境确认首开加载页、自动切换聊天页及失败提示。
