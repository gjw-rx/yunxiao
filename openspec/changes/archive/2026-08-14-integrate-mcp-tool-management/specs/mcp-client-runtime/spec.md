## ADDED Requirements

### Requirement: MCP Client 按启用配置建立连接
McpClientManager SHALL 为每个 enabled Server 创建独立 Connection，并 SHALL 仅在工作区 trusted、配置 revision 仍为最新且所需 Secrets 完整时连接。disabled Server SHALL 不创建 Transport。任一 Server 失败 SHALL NOT 阻止其他 MCP Server、本地工具或聊天主流程。

#### Scenario: 启用 Server 连接
- **WHEN** trusted 工作区加载一个 enabled 且配置完整的 Server
- **THEN** Manager 创建该 Server Connection 并进入 connecting

#### Scenario: 不可信工作区
- **WHEN** 工作区不可信且存在 enabled Servers
- **THEN** Servers 保持 waiting_workspace_trust，不启动进程也不发起网络请求

#### Scenario: Secret 缺失
- **WHEN** 远程配置声明 Authorization header key 但 SecretStorage 没有值
- **THEN** 该 Server 进入 error 且连接前失败，不影响其他 Server

### Requirement: STDIO Transport 生命周期
STDIO Connection SHALL 使用官方 StdioClientTransport 按 command、args、当前工作区解析的 cwd 和 SecretStorage env 启动受管理子进程。命令 MUST 不经过 shell 拼接，stdout SHALL 专用于 MCP，stderr SHALL 有界消费。关闭时 SHALL 取消请求、关闭 Client/Transport 并确保子进程有界退出。

#### Scenario: 启动 CodeGraph
- **WHEN** 配置 `codegraph` command 和 `["serve", "--mcp"]`
- **THEN** Transport 在当前主工作区 cwd 启动子进程并通过 stdin/stdout 连接 MCP

#### Scenario: command 不存在
- **WHEN** STDIO command 无法 spawn
- **THEN** Server 进入 error、记录 server ID 和错误类别且不发布工具

#### Scenario: stderr 输出
- **WHEN** Server 向 stderr 输出大量诊断文本
- **THEN** stdout 协议不受影响且系统只保留有界 stderr 尾部，不把正文推给模型

#### Scenario: 停用清理
- **WHEN** 用户停用 STDIO Server
- **THEN** 进行中请求结束且受管理子进程在有界时间内退出

### Requirement: Streamable HTTP Transport 生命周期
远程 Connection SHALL 使用官方 StreamableHTTPClientTransport 连接配置 URL，并 SHALL 只在相同 origin 请求中附加 SecretStorage headers。Transport SHALL 支持 stateful 与 stateless Server；关闭 stateful session 时 SHALL 先尝试 terminate session 再关闭 Client。跨 origin redirect MUST 被拒绝。

#### Scenario: HTTPS Server 连接
- **WHEN** enabled 远程 Server 配置有效 HTTPS URL 和 Authorization header
- **THEN** Transport 向该 origin 建立 Streamable HTTP MCP 连接并完成初始化

#### Scenario: Stateful session 关闭
- **WHEN** Server 建立 MCP session 且用户停用连接
- **THEN** Client 尝试终止服务端 session 后关闭本地 Transport

#### Scenario: 跨 origin 重定向
- **WHEN** MCP endpoint 重定向到不同 origin
- **THEN** Client 拒绝重定向且不会向新 origin 发送配置 headers

### Requirement: Legacy SSE 兼容回退
只有当远程配置显式启用 `legacySseFallback` 且 Streamable HTTP 失败被分类为 Transport/协议不匹配时，Connection SHALL 关闭第一套 Client/Transport，并 SHALL 使用全新 Client 与 SSEClientTransport 连接同一 URL。认证、TLS、DNS、超时、取消和通用 5xx MUST NOT 触发回退。

#### Scenario: Streamable HTTP 不兼容后回退成功
- **WHEN** Server 只支持旧 HTTP+SSE、配置启用 fallback 且主连接返回兼容性错误
- **THEN** 系统使用全新 Client 通过 legacy SSE 连接并记录 actualTransport 为 legacy-sse

#### Scenario: 未启用回退
- **WHEN** Streamable HTTP 兼容失败但配置未启用 fallback
- **THEN** Server 进入 error 且不创建 SSEClientTransport

#### Scenario: 认证失败不回退
- **WHEN** Streamable HTTP 返回 401 或 403
- **THEN** Server 报告认证错误且不尝试 legacy SSE

#### Scenario: 网络超时不回退
- **WHEN** Streamable HTTP 连接超时
- **THEN** Server 报告超时且不使用另一 Transport 重试

### Requirement: MCP 初始化与 Server 元数据
每个 Transport SHALL 通过官方 Client 完成 MCP 连接和协议协商，并 SHALL 获取 Server info、capabilities 与可选 instructions。Connection 只有在连接成功并完成工具发现后才能进入 ready。协议不兼容 SHALL 局部降级该 Server。

#### Scenario: 初始化成功
- **WHEN** Server 返回兼容协议和 tools capability
- **THEN** Connection 保存协商元数据并开始 tools/list

#### Scenario: 没有 tools capability
- **WHEN** Server 连接成功但不声明 tools capability
- **THEN** Server 可保持已连接但不发布模型工具，设置页显示工具数为零

#### Scenario: 协议协商失败
- **WHEN** Client 无法与 Server 协商兼容协议
- **THEN** Server 进入 error 且不影响其他连接

### Requirement: MCP 工具分页发现与变化
Connection SHALL 调用 `tools/list` 并跟随 cursor 直到获得完整列表，再一次发布不可变工具快照。若 Server 声明工具列表变化并发出对应通知，Connection SHALL 重新完整分页发现。刷新失败 MUST NOT 发布半量列表。

#### Scenario: 分页发现
- **WHEN** tools/list 分两页返回工具
- **THEN** Manager 只在两页全部完成后发布完整列表

#### Scenario: 工具列表变化
- **WHEN** ready Server 通知工具列表变化
- **THEN** Connection 重新发现并原子替换该 Server 工具

#### Scenario: 刷新失败
- **WHEN** 第二页发现失败
- **THEN** Server 进入可诊断错误且模型不会看到半量新列表

### Requirement: MCP tools/call
Manager SHALL 根据可信目录项把模型调用路由到指定 Server 的原始 MCP 工具名，并 SHALL 把经本地校验的 arguments 传给 Client `tools/call`。Transport、URL、command、headers 与 env MUST NOT 来自模型参数。并发调用结果 SHALL 与各自请求正确关联。

#### Scenario: STDIO 工具调用
- **WHEN** Bridge 调用 ready CodeGraph 的原始 `codegraph_explore`
- **THEN** Client 向该 STDIO Server 发送一次 tools/call 并返回对应 CallToolResult

#### Scenario: 远程工具调用
- **WHEN** Bridge 调用一个 Streamable HTTP Server 工具
- **THEN** Client 使用既有远程 session 发送 tools/call 且不让模型改变 endpoint

#### Scenario: 并发结果乱序
- **WHEN** 两个只读调用并发且第二个先返回
- **THEN** 每个 Promise 仍返回自己的 CallToolResult，不发生串线

### Requirement: 调用取消与超时
每次 `tools/call` SHALL 绑定 AgentLoop AbortSignal，并应用 Server callTimeoutMs 或全局工具超时。用户取消 SHALL 返回 cancelled；超时 SHALL 返回结构化 error。每个调用 SHALL 至多完成一次，迟到结果 SHALL 被忽略。

#### Scenario: 用户取消 STDIO 调用
- **WHEN** AbortSignal 在 STDIO tools/call 期间触发
- **THEN** Client 发送适用的取消语义并返回一个 cancelled 结果

#### Scenario: 取消 Streamable HTTP 调用
- **WHEN** AbortSignal 在远程响应流期间触发
- **THEN** Transport 终止该请求流并返回一个 cancelled 结果

#### Scenario: 调用超时
- **WHEN** Server 未在有效 callTimeoutMs 内响应
- **THEN** 系统结束等待、返回 timeout error 且不自动重放 tools/call

### Requirement: 连接重建与故障隔离
用户重连或配置 revision 变化时，Manager SHALL 先使旧 Connection 拒绝新调用和下线动态工具/instructions，再有界关闭旧资源并创建新 Connection。异常退出、远程流断开或协议错误 SHALL 只影响对应 Server。过期 revision 的迟到事件 MUST 被忽略。

#### Scenario: 编辑 active Server
- **WHEN** Store 保存该 Server 新 revision
- **THEN** 旧工具下线、旧连接关闭并按新配置建立连接

#### Scenario: 一个 Server 异常退出
- **WHEN** 两个 Server ready 且其中一个 STDIO 进程退出
- **THEN** 只下线退出 Server 的工具/instructions，另一个 Server 和本地工具继续可用

#### Scenario: 旧连接迟到 ready
- **WHEN** 新 revision 已应用而旧 Connection 随后发出 ready
- **THEN** Manager 丢弃旧事件且不重新发布旧工具

### Requirement: 扩展停用清理
McpClientManager SHALL 注册到 ExtensionContext subscriptions。扩展停用时 SHALL 停止接受新调用、取消进行中调用，并行有界关闭所有 Client/Transport/STDIO 进程和远程 session。清理失败 SHALL 被记录但 MUST NOT 无限阻塞停用。

#### Scenario: 多 Transport 停用
- **WHEN** 扩展停用且存在 STDIO、Streamable HTTP 与 legacy SSE 连接
- **THEN** Manager 对每个连接执行对应关闭流程并完成有界 dispose

