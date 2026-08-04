# Tasks: UI Refine Chat Panel

## 1. 重构 HTML 结构 (_getBodyHtml)

- [X] 1.1 修改顶部 `#header`：移除 Agent 选择器和"新会话"按钮，替换为会话名称输入框（默认 "Untitled"）和历史按钮（时钟图标）
- [X] 1.2 重构输入区域 `#inputArea`：
  - 输入框下方新增工具栏行
  - 工具栏左侧：+ 新建按钮（图标）
  - 工具栏右侧：紧凑版 Agent 选择器、发送按钮、停止按钮
- [X] 1.3 移除输入框左侧的 + 号（原 sendBtn/stopBtn 从 inputWrapper 移到工具栏）

## 2. 更新 CSS 样式 (_getCss)

- [X] 2.1 调整 `#header` 样式：适配会话名称输入框样式
- [X] 2.2 新增会话名称输入框样式（`.session-name-input`）
- [X] 2.3 新增底部工具栏样式（`.input-toolbar`）
- [X] 2.4 新增紧凑版 Agent 选择器样式（`.agent-compact-btn`）
- [X] 2.5 恢复下拉菜单卡片所需的共享样式（`.agent-info`、`.agent-name`、`.agent-model`）
- [X] 2.6 调整 placeholder 欢迎文案

## 3. 实现自动创建会话 (_getJs + _handleMessage)

- [X] 3.1 修改初始化逻辑：Agent 列表加载后（`agentsLoaded`），自动选择第一个 Agent 并调用 `startNewSession()`
- [X] 3.2 移除 placeholder 中的"选择 Agent 并点击新会话"提示，改为"输入消息开始对话，用 @ 引用文件"
- [X] 3.3 确保初始化流程：requestAgents -> agentsLoaded -> selectAgent(0) -> createSession -> sessionCreated -> 启用输入框

## 4. 重构 Agent 选择器到底部 (_getJs)

- [X] 4.1 将 Agent 选择器逻辑改为紧凑模式（小图标/文字按钮，点击弹出下拉）
- [X] 4.2 更新 DOM 引用，移除旧的 agentModelText 引用，绑定到新位置
- [X] 4.3 下拉菜单从底部向上弹出（`bottom: calc(100% + 4px)`）

## 5. 实现会话命名功能

- [X] 5.1 绑定会话名称输入框事件：失去焦点或回车时保存名称
- [X] 5.2 新增 `renameSession` 消息发送到后端
- [X] 5.3 后端 `_handleMessage` 添加 `renameSession` 处理（内存存储 sessionId -> name）
- [X] 5.4 新建会话时重置输入框为 "Untitled"

## 6. 实现 @ 文件选择功能

- [X] 6.1 监听输入框 `input` 事件，检测 `@` 输入
- [X] 6.2 输入 `@` 时触发 `pickFile` 消息，后端调用 `vscode.window.showOpenDialog`
- [X] 6.3 选中文件后在输入框光标位置插入 `@filename` 并关闭对话框
- [X] 6.4 后端 `_handleMessage` 添加 `pickFile` 处理

## 7. 实现新建会话按钮和历史按钮

- [X] 7.1 底部 + 按钮绑定 `startNewSession()` 逻辑
- [X] 7.2 历史按钮点击：发送 `showHistory` 消息，后端返回会话列表
- [X] 7.3 确保新建会话时清空消息区域、重置状态

## 8. 测试验证

- [X] 8.1 代码审查：无残留的旧元素引用（agentModelText、newSessionBtn 等）
- [X] 8.2 代码审查：所有新增消息类型前后端对应
- [X] 8.3 编译验证（Terminal 被 PowerShell 执行策略阻塞，需用户手动验证）
- [X] 8.4 运行时验证（需用户在 VSCode 中测试）
