# settings-page Specification

## Purpose
在 VS Code 编辑器区域提供云效 Agent 的独立设置标签页，用于展示模型、Skill 与使用情况的前端配置入口。

## Requirements

### Requirement: 聊天头部设置入口
系统 SHALL 在聊天 Webview 的会话操作区提供设置按钮，且该按钮的视觉顺序位于“新建会话”之后、“历史会话”之前。该按钮 MUST 具有可访问名称与提示文本。

#### Scenario: 从聊天头部打开设置标签

- **WHEN** 用户点击设置按钮
- **THEN** 编辑器区域打开独立设置标签，且不创建、删除或切换当前会话

### Requirement: 独立设置编辑器标签
系统 SHALL 通过扩展宿主在编辑器区域打开标题为“云效 Agent 设置”的独立 WebviewPanel 标签。聊天 Webview MUST 保持当前会话标识、已加载消息、输入草稿和已有前端状态。设置标签 SHALL 仅通过定义的模型配置与 Skill 管理消息协议向扩展宿主请求数据或写入操作。

#### Scenario: 重复打开设置标签

- **WHEN** 用户在设置标签已经打开时再次点击聊天头部的设置按钮
- **THEN** 系统聚焦已有设置标签，不创建重复标签

### Requirement: 设置分类与可操作内容
设置页 SHALL 使用左侧分类导航和右侧内容区展示“模型”“Skill”“MCP”“使用情况”四个分类，导航顺序 SHALL 为模型、Skill、MCP、使用情况，默认显示“模型”。模型分类 MUST 显示可编辑的模型配置和保存状态；Skill 分类 MUST 显示已加载 Skill 并提供安装操作的状态反馈；MCP 分类 MUST 提供 JSON 配置入口与 MCP Server 列表管理；使用情况内容 MUST 明确不代表真实 token、费用或账户统计。

#### Scenario: 查看并保存模型配置

- **WHEN** 用户在设置页默认的“模型”分类加载或保存有效配置
- **THEN** 页面显示宿主返回的当前非敏感字段及保存结果，且不会显示 API Key 明文

#### Scenario: 查看 Skill 管理内容

- **WHEN** 用户在设置页点击“Skill”分类
- **THEN** 页面请求并显示当前已加载 Skill，且安装反馈会更新列表或显示失败原因

#### Scenario: 查看 MCP 管理内容

- **WHEN** 用户在设置页点击“MCP”分类
- **THEN** 页面请求并显示当前 MCP Server 快照，并提供 JSON 新增/编辑、启停、重连和删除操作

#### Scenario: 查看使用情况占位内容

- **WHEN** 用户在设置页点击“使用情况”分类
- **THEN** 右侧显示使用情况的静态占位内容，且不会请求或显示真实 token、费用或账户数据

### Requirement: 设置页 MCP 异步状态反馈
设置页 SHALL 区分 MCP 配置保存结果、操作已接受状态和最终连接状态。MCP Server 的连接或重连 SHALL NOT 阻塞整个设置页面；Host 推送新状态时页面 SHALL 只更新相关 MCP 快照，模型与 Skill 草稿保持不变。

#### Scenario: 重连进行中
- **WHEN** 用户点击 MCP Server 重连且 Host 接受操作
- **THEN** 页面显示 reconnecting，并允许继续浏览其他设置分类

#### Scenario: 状态推送不清空模型草稿
- **WHEN** 用户正在编辑模型且 Host 推送 MCP ready 状态
- **THEN** MCP 快照更新但模型表单草稿保持不变

### Requirement: 设置页视觉层级
设置页 SHALL 采用与当前 VS Code 主题一致的克制、原生编辑器风格，并以分类侧栏、页面标题、说明文字和分组卡片/行项目建立清晰的信息层级。内容区 MUST 在可用高度内滚动，分类导航在窄 Webview 宽度下仍可访问。

#### Scenario: 在受限 Webview 空间查看设置

- **WHEN** 设置内容高度超过当前 Webview 的可视高度
- **THEN** 用户可滚动内容区查看全部静态内容，且仍可访问分类导航
