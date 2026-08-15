## ADDED Requirements

### Requirement: 对话入口在首次 Skill 同步期间可用
系统 SHALL 在首次 Skill 同步完成前注册云效 Agent 侧栏 Webview Provider 和打开命令。用户打开对话入口时，Webview MUST 显示居中的插件图标与“正在加载 Skill…”状态，而不得显示空白页面或等待到同步结束后才创建视图。

#### Scenario: 大量 Skill 文件时首次打开侧栏
- **WHEN** 扩展正在执行首次 Skill 同步且用户打开云效 Agent 侧栏
- **THEN** 侧栏立即显示主题适配的图标加载页，并且同步在后台继续执行

### Requirement: 未就绪运行时不得执行聊天业务操作
系统 SHALL 将运行时状态区分为 `initializing`、`ready` 和 `failed`。当状态不是 `ready` 时，Webview MUST 不创建会话、不请求历史或斜杠命令，也不展示可用的聊天输入和 Skill 选择；Host MUST 不执行该状态下收到的会话、消息、历史或 Skill 业务请求。

#### Scenario: 加载页收到首次握手
- **WHEN** Webview 在运行时处于 `initializing` 时挂载并发送握手
- **THEN** Host 返回当前初始化状态，且 Webview 保持加载页而不创建会话

#### Scenario: 旧页面发送业务消息
- **WHEN** 运行时尚未就绪的 Webview 向 Host 发送创建会话、发送消息、读取历史或请求斜杠命令
- **THEN** Host 不访问未完成装配的会话或 Skill 依赖，并记录可定位的忽略日志

### Requirement: 后台同步完成后在当前面板恢复聊天
首次 Skill 同步和运行时装配成功后，Host SHALL 向所有已解析的聊天 Webview 推送 `ready` 状态，并刷新斜杠命令。Webview MUST 在首次收到 `ready` 后执行一次现有的初始数据请求和首会话创建，无需用户关闭、重开或刷新面板。

#### Scenario: 同步成功且面板已打开
- **WHEN** 用户正在加载页等待且首次 Skill 同步成功
- **THEN** 加载页切换为聊天界面、自动创建或恢复首个会话，并显示同步后的斜杠命令

#### Scenario: 同步成功后 Webview 重建
- **WHEN** 运行时已处于 `ready`，聊天 Webview 被隐藏后恢复或重新解析
- **THEN** Host 在握手时返回 `ready`，且新 Webview 只执行一次初始会话创建流程

### Requirement: 后台初始化可诊断且失败可见
系统 MUST 为首次 Skill 同步记录开始、完成或失败日志，并在完成或失败日志中包含耗时和状态。初始化失败时，Host SHALL 向当前及后续打开的聊天 Webview 发布 `failed` 状态；Webview MUST 展示明确的加载失败提示并保持聊天操作不可用。

#### Scenario: 首次 Skill 同步失败
- **WHEN** 首次 Skill 同步抛出异常
- **THEN** 日志记录失败原因和耗时，聊天 Webview 显示失败提示且不创建会话或发送消息
