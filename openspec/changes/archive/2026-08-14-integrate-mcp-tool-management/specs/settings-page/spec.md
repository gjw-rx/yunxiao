## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: 设置页 MCP 异步状态反馈
设置页 SHALL 区分 MCP 配置保存结果、操作已接受状态和最终连接状态。MCP Server 的连接或重连 SHALL NOT 阻塞整个设置页面；Host 推送新状态时页面 SHALL 只更新相关 MCP 快照，模型与 Skill 草稿保持不变。

#### Scenario: 重连进行中
- **WHEN** 用户点击 MCP Server 重连且 Host 接受操作
- **THEN** 页面显示 reconnecting，并允许继续浏览其他设置分类

#### Scenario: 状态推送不清空模型草稿
- **WHEN** 用户正在编辑模型且 Host 推送 MCP ready 状态
- **THEN** MCP 快照更新但模型表单草稿保持不变

