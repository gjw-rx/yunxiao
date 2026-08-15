# mcp-settings-management Specification

## Purpose
定义设置页 MCP 管理台：MCP 分类、管理台视觉布局、JSON 新增/编辑/批量导入、Transport 校验、Server 列表与运行状态、Server 详情、启停/重连/删除、消息协议与 revision 一致性。

## Requirements

### Requirement: 设置页提供 MCP 分类
设置 Webview SHALL 在“模型”“Skill”“使用情况”之外提供独立“MCP”分类，导航顺序 SHALL 为模型、Skill、MCP、使用情况。MCP 分类 SHALL 明确说明配置由插件私有存储管理且系统不会自动读取项目 `.mcp.json`。

#### Scenario: 打开 MCP 设置
- **WHEN** 用户点击设置页左侧“MCP”导航项
- **THEN** 页面展示 MCP JSON 配置入口和已配置 Server 管理列表，且不读取工作区 MCP 文件

#### Scenario: 窄窗口仍可访问
- **WHEN** 设置 Webview 宽度受限
- **THEN** MCP 导航、JSON 编辑区和 Server 操作仍可访问且页面不产生不可操作的横向溢出

### Requirement: MCP 管理台视觉布局
MCP 设置页 SHALL 采用管理台式信息层级：列表态 MUST 展示“已连接 Server / Server 总数 / 工具总数”概览、可访问的 Server 搜索框和“当前项目”服务分区；添加或编辑时 SHALL 展示独立表单视图、返回列表操作、配置方式标签、JSON 编辑区和固定的取消/保存操作。搜索 MUST 仅过滤当前 Webview 快照，MUST NOT 改变持久化配置或运行状态。

#### Scenario: 在列表中搜索 Server
- **WHEN** 用户输入 Server ID 或 Transport 关键字
- **THEN** 页面仅展示匹配当前快照的服务卡片，概览与 Host 保存配置保持不变

#### Scenario: 打开添加 Server 表单
- **WHEN** 用户在 MCP 列表点击“添加服务器”
- **THEN** 页面展示独立添加表单及 JSON 模板，用户可返回列表而不发送保存消息

### Requirement: JSON 新增与批量导入
MCP 设置页 SHALL 接受 `{ "mcpServers": { ... } }` JSON 文本，并 SHALL 支持一次新增一个或多个 Server。Extension Host MUST 在保存前重新解析并校验 JSON；任何语法、顶层结构、Server ID、Transport 或字段错误 SHALL 使整次导入失败，既有配置与 Secrets 保持不变。新增模式遇到既有 Server ID SHALL 拒绝且不得静默覆盖。

#### Scenario: 批量导入合法配置
- **WHEN** 用户提交包含一个 STDIO 和一个 Streamable HTTP Server 的合法 JSON
- **THEN** 两个 Server 在同一事务中保存并出现在列表中

#### Scenario: JSON 语法错误
- **WHEN** 用户提交无法解析的 JSON
- **THEN** 页面展示可读语法错误，Host 不修改任何配置或连接

#### Scenario: 单个 Server 非法导致整体回滚
- **WHEN** 批量 JSON 中一个 Server 合法而另一个缺少必填字段
- **THEN** 整次导入被拒绝且合法 Server 也不会被部分保存

#### Scenario: 新增 ID 冲突
- **WHEN** 新增 JSON 包含已配置 Server ID
- **THEN** Host 返回定位到该 ID 的冲突错误且既有 Server 不变

### Requirement: JSON 编辑现有 Server
用户 SHALL 能从 Server 列表打开单 Server JSON 编辑器。编辑模式 SHALL 只更新被选中的 Server，MUST NOT 通过修改 JSON key 隐式重命名 Server。保存成功 SHALL 原子更新持久化配置并使运行时应用新 revision；保存失败 SHALL 保留旧连接配置。

#### Scenario: 编辑 Server URL
- **WHEN** 用户编辑一个远程 Server 的 URL 并通过 Host 校验
- **THEN** Store 保存新 revision，旧连接下线后按新 URL 重建连接

#### Scenario: 编辑时尝试重命名
- **WHEN** 编辑 JSON 的 Server key 与正在编辑的 Server ID 不同
- **THEN** Host 拒绝保存并提示通过删除后新增完成重命名

#### Scenario: 编辑失败保留旧运行时
- **WHEN** 用户提交的编辑 JSON 不合法
- **THEN** 旧持久化配置和旧运行连接均保持不变

### Requirement: MCP JSON Transport 校验
Host SHALL 仅接受 `type: "stdio"` 或 `type: "streamable-http"`。STDIO Server MUST 包含非空 command，可选 args/env/cwd/enabled/connectTimeoutMs/callTimeoutMs；远程 Server MUST 包含合法 URL，可选 headers/legacySseFallback/enabled/connectTimeoutMs/callTimeoutMs。Host SHALL 拒绝未知字段并返回精确字段路径。

#### Scenario: 合法 STDIO 配置
- **WHEN** Server 声明 `type: "stdio"`、command 和字符串 args
- **THEN** 配置通过 Transport 校验

#### Scenario: 合法远程配置
- **WHEN** Server 声明 `type: "streamable-http"` 和 HTTPS MCP URL
- **THEN** 配置通过 Transport 校验并可选择 legacySseFallback

#### Scenario: 非法 Transport
- **WHEN** Server 声明 `type: "websocket"`
- **THEN** Host 拒绝并返回 `mcpServers.<id>.type` 错误路径

#### Scenario: 远程 Server 使用不安全 URL
- **WHEN** 非 loopback 远程 Server 使用 HTTP URL
- **THEN** Host 拒绝配置且不发起网络请求

### Requirement: Server 列表与运行状态
MCP 设置页 SHALL 展示每个 Server 的 ID、配置 Transport、实际 Transport、启用状态、运行状态、已发现工具数量和最近一次有界错误摘要。状态 SHALL 至少区分 disabled、waiting_workspace_trust、connecting、ready、reconnecting、error 和 stopping。Host SHALL 在状态或工具快照变化时主动推送最新视图。

#### Scenario: STDIO Server ready
- **WHEN** 已启用 STDIO Server 完成连接并发现三个工具
- **THEN** 列表显示配置/实际 Transport 为 STDIO、状态 ready、工具数为 3

#### Scenario: 远程 Server 使用 SSE 回退
- **WHEN** Streamable HTTP 兼容失败后成功连接 legacy SSE
- **THEN** 列表仍显示配置类型 Streamable HTTP，并将实际 Transport 标为 legacy SSE

#### Scenario: Server 连接失败
- **WHEN** Server 进入 error 状态
- **THEN** 列表展示不含秘密的有界错误摘要，其他 Server 状态不受影响

### Requirement: Server 详情展示已发现工具
ready Server 的列表项 SHALL 可展开查看当前发现的 MCP 原始工具名和 description。页面 MUST NOT 展示 env/header 明文、完整 ToolResult、Server instructions 或无界 inputSchema。

#### Scenario: 展开 ready Server
- **WHEN** 用户展开一个已发现工具的 ready Server
- **THEN** 页面显示工具名称和说明，但不显示任何凭据值

#### Scenario: 非 ready Server
- **WHEN** 用户展开 disabled 或 error Server
- **THEN** 页面显示当前状态说明且不展示过期工具列表

### Requirement: Server 启停、重连与删除
用户 SHALL 能启用、停用、重连和删除 MCP Server。启停 SHALL 持久化 enabled 状态；重连 SHALL 不改配置，仅重建指定 Connection；删除 SHALL 经二次确认后停止连接、下线工具、删除非敏感配置与全部关联 Secrets。操作反馈 SHALL 区分“已接受”和最终连接状态。

#### Scenario: 停用 ready Server
- **WHEN** 用户关闭一个 ready Server 的启用开关
- **THEN** Host 下线该 Server 工具、关闭连接、保存 disabled，并推送最终状态

#### Scenario: 重连 error Server
- **WHEN** 用户点击 error Server 的重连操作
- **THEN** Host 使用当前保存配置重建该 Server Connection 且不修改其他 Server

#### Scenario: 删除被取消
- **WHEN** 用户在二次确认中取消删除
- **THEN** Host 不收到删除请求且 Server 保持不变

#### Scenario: 删除确认
- **WHEN** 用户确认删除 Server
- **THEN** Host 停止运行时并删除配置与 SecretStorage 值，列表不再显示该 Server

### Requirement: MCP 设置消息协议
Webview 与 Extension Host SHALL 使用判别联合消息管理 MCP：请求快照、保存 JSON、启停、重连和删除。Host MUST 对每条消息的 command、Server ID、mode 与 JSON 字段进行运行时校验，不能依赖 Webview TypeScript 类型。MCP 错误响应 SHALL 包含 operation、可读 message 和可选 fieldPath。

#### Scenario: 设置页初次请求
- **WHEN** SettingsPage 挂载
- **THEN** Webview 发送 `requestMcpSettings`，Host 返回不含秘密的 `mcpSettings` 快照

#### Scenario: 伪造操作消息
- **WHEN** Host 收到缺少 Server ID 的启停消息
- **THEN** Host 拒绝操作、记录中文日志并返回 MCP 设置错误

### Requirement: MCP 操作串行与 revision 一致性
所有 MCP 配置写入和运行时应用 SHALL 按消息到达顺序串行，并为持久化文档分配递增 revision。Manager MUST 忽略旧 revision 的迟到连接和状态更新，设置页最终快照 SHALL 对应最新持久化 revision。

#### Scenario: 快速连续编辑
- **WHEN** 用户快速保存同一 Server 的两个有效编辑
- **THEN** Host 串行应用且最终配置/连接对应第二次编辑，不被第一次的迟到连接覆盖

#### Scenario: 禁用期间连接完成
- **WHEN** Server connecting 时用户立即禁用，旧连接随后成功完成
- **THEN** 旧 revision 的 ready 事件被忽略，Server 最终保持 disabled 且不发布工具
