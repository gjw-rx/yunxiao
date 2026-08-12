## Why

云效 Agent 在扩展激活阶段同步扫描多个 Skill 目录；目录中文件较多时，侧栏对话入口直到扫描完成后才会注册，造成首次打开长时间空白或无反馈。应让用户先看到可识别的插件加载界面，再在后台完成 Skill 初始化，以改善首开感知速度。

## What Changes

- 将首次 Skill 同步从阻塞侧栏 Webview Provider 注册的激活路径中移出，改为插件界面可打开后的后台初始化任务。
- 为聊天 Webview 增加启动就绪状态：Skill 初始化未完成时显示居中的云效 Agent 图标与加载提示，不创建会话、不加载历史，也不允许发送消息或使用 Skill 选择。
- 初始化成功后向已打开的 Webview 推送就绪事件，恢复现有初始化流程并刷新斜杠命令；用户无需关闭或重新打开面板。
- 保持后续来源切换、目录保存和 ZIP 安装后的 Skill 同步串行与现有刷新行为不变。
- 记录后台初始化的开始、完成、失败和耗时日志，便于定位启动性能与故障。

## Capabilities

### New Capabilities

- `progressive-plugin-readiness`: 在后台同步 Skill 时让聊天面板立即可见，并以受控的加载与就绪状态保护聊天操作。

### Modified Capabilities

- `webview-ui-runtime`: 聊天 Webview 的宿主消息协议和首挂载行为需要支持等待扩展运行时就绪后再加载会话数据。
- `skill-settings-management`: 初始 Skill 同步改为异步后，设置中的 Skill 快照与后续手动重新同步仍须反映已完成的注册表状态。

## Impact

- 受影响代码：`src/extension.ts` 的激活与 Skill 同步调度、`src/chatPanel.ts` 的运行时就绪通知与消息保护、`src/webview-ui/` 的协议、状态和启动加载视图，以及相关单元测试。
- 不改变 Skill 的目录优先级、去重规则、配置格式或用户可用的 Skill 内容；不引入外部依赖或新的 VS Code 配置项。
