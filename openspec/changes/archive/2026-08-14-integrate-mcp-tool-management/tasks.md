## 1. MCP SDK 与共享类型

- [x] 1.1 调研并锁定与当前 VS Code Extension Host/Node 版本兼容的官方 MCP TypeScript Client 版本，安装 Client、STDIO 与远程 Transport 所需运行时依赖并更新 lockfile
- [x] 1.2 新建 `src/mcp/` 模块与集中类型，定义 Store document、STDIO/Streamable HTTP 配置联合、Server status、actual transport、tool catalog、instructions 和 result metadata，补齐文件职责与中文 JSDoc
- [x] 1.3 增加最小打包测试，验证官方 Client、StdioClientTransport、StreamableHTTPClientTransport 与 SSEClientTransport 的导入路径能被 esbuild 打包

## 2. JSON 解析与配置校验

- [x] 2.1 先编写 MCP JSON parser 测试，覆盖空输入、语法错误、顶层结构、批量 Server、合法 STDIO、合法 Streamable HTTP、未知 type、未知字段和精确 fieldPath
- [x] 2.2 实现 `{ mcpServers }` 严格 parser 与判别联合校验，不使用不受控类型断言接受 Webview 数据
- [x] 2.3 先编写 STDIO 字段测试，覆盖 command、args/env 字符串类型、enabled、超时、默认 cwd、相对 cwd、绝对/越界 cwd 和无 shell 拼接保证
- [x] 2.4 实现 STDIO 配置归一化，cwd 通过 pathGuard 解析到当前主工作区，保留 command/args 原始参数数组
- [x] 2.5 先编写远程 URL 测试，覆盖 HTTPS、loopback HTTP、非 loopback HTTP 拒绝、URL 用户信息/query、跨 origin redirect 策略和 headers 类型
- [x] 2.6 实现 Streamable HTTP 配置归一化、URL 安全校验、origin 绑定和 legacySseFallback/超时默认值
- [x] 2.7 先编写导入语义测试，覆盖批量原子失败、新增 ID 冲突、编辑只允许一个 Server、禁止隐式重命名
- [x] 2.8 实现 add/import/edit 命令的纯函数事务计划，确保校验失败不会产生部分变更

## 3. MCP 私有 Store 与秘密管理

- [x] 3.1 先编写 `McpConfigStore` 文档测试，覆盖空 Store、version、revision、用户级 `~/.yunForce/mcp/servers.json` 路径、非敏感序列化和不读取工作区 `.mcp.json`
- [x] 3.2 实现 Store 文档读取、schema 校验、临时文件写入与原子替换，所有关键分支输出不含正文的中文日志
- [x] 3.3 先编写 Secrets 测试，覆盖 env/header 全值进入 SecretStorage、普通文件无值、设置快照只含配置状态
- [x] 3.4 实现稳定 Secret key、env/header 拆分和运行时秘密装配，禁止向 Webview 返回明文
- [x] 3.5 先编写 `<已安全保存>` 占位测试，覆盖保留、替换、删除、新 Server 伪造占位和已有 Secret 缺失
- [x] 3.6 实现单 Server 编辑视图与占位保存语义，保存成功后立即释放明文输入引用
- [x] 3.7 先编写批量事务与回滚测试，覆盖 SecretStorage 中途失败、普通文件写失败、revision 不发布和新 Secret 清理
- [x] 3.8 实现 Store 串行写队列与尽力回滚，只有文档和 Secrets 都成功后才返回新 revision
- [x] 3.9 先编写 enable/delete 测试，验证 enabled revision 更新和删除 Server 时清理全部 Secrets
- [x] 3.10 实现 `setEnabled/delete/getSettingsView/getRuntimeConfig` 等 Store API

## 4. 设置页消息协议与宿主路由

- [x] 4.1 扩展 `src/webview-ui/protocol.ts`，增加 McpServerView、McpToolView、状态枚举和 request/save/enable/reconnect/delete/response 判别联合消息
- [x] 4.2 先编写 `chatPanel.settings` 宿主协议测试，覆盖请求快照、JSON 保存、字段错误、伪造 Server ID、启停、重连、删除和操作反馈
- [x] 4.3 扩展 SettingsPanelDeps 与 `_handleSettingsMessage`，所有 MCP 消息在 Host 再校验，并将字段错误映射为可显示 `fieldPath`
- [x] 4.4 增加 Host 主动推送 MCP 状态快照的方法，确保设置面板关闭或未打开时安全跳过

## 5. MCP 设置页面 UI

- [x] 5.1 先扩充 SettingsPage 测试，验证导航顺序为模型/Skill/MCP/使用情况，挂载请求 MCP 快照且默认模型页行为不变
- [x] 5.2 实现 MCP 导航图标、页面标题和“配置由插件私有管理、不读取项目文件”说明
- [x] 5.3 先编写 JSON 编辑器测试，覆盖打开/关闭、模板、批量新增、编辑预填、秘密占位、语法错误、Host fieldPath 和保存中状态
- [x] 5.4 实现 MCP JSON 编辑卡片与 add/edit 模式，不在前端日志或反馈中输出秘密明文
- [x] 5.5 先编写 Server 列表测试，覆盖空状态、配置/实际 Transport、状态、工具数、错误摘要、展开工具名称和 description
- [x] 5.6 实现响应式 MCP Server 列表和详情展开，disabled/waiting/connecting/ready/reconnecting/error/stopping 状态视觉可区分且不只依赖颜色
- [x] 5.7 先编写操作测试，覆盖启停、重连、编辑、删除二次确认、操作已接受与最终状态推送
- [x] 5.8 实现 Server 操作按钮、无障碍 label、确认交互与反馈，不让 MCP 状态推送清空模型/Skill 草稿
- [x] 5.9 增加桌面与窄容器 CSS 测试/样式，保证长 Server ID、URL、工具描述和 JSON 文本不会破坏布局
- [x] 5.10 按 MCP 管理台参考风格重构列表态与添加态：补齐概览统计、搜索、项目 Server 卡片、独立表单和响应式样式；暗色主题复用插件主/次/危险按钮 token、低对比表面和带 CTA 的空状态，主按钮保持单行；保留既有 Host 协议与操作语义，并补充 Webview 布局测试

## 6. MCP 工具命名、Schema、权限与结果

- [x] 6.1 先编写工具名映射测试，覆盖 `mcp__server__tool`、非法字符、空片段、长度上限、稳定哈希与最终冲突
- [x] 6.2 实现 `McpToolNameMapper` 和不可变反向 catalog，执行时禁止从 exposed name 临时拆分目的地
- [x] 6.3 先编写 MCP Tool schema 测试，覆盖 description 来源、inputSchema 原样复用、缺失 schema 严格回退和 JSON 可序列化
- [x] 6.4 实现 MCP Tool → ToolSchema 转换和 destructive/readOnly/unknown 权限映射
- [x] 6.5 先编写并行策略测试，覆盖明确只读且非 open-world 可并行，其余串行
- [x] 6.6 实现 MCP Adapter canParallel 规则并保证 Transport 不影响权限
- [x] 6.7 先编写 CallToolResult 测试，覆盖 text、structuredContent、text resource、resource link、多段顺序、空结果、isError 和未知类型
- [x] 6.8 实现 CallToolResult 文本/结构化归一化与 metadata
- [x] 6.9 先编写 image/audio/blob 测试，证明 base64 不进入 ToolResult 或日志
- [x] 6.10 实现非文本安全描述，并验证所有结果继续经过 BaseTool 脱敏与行/字节/字符治理

## 7. STDIO Connection

- [x] 7.1 创建可编程测试 fixture STDIO MCP Server，支持 initialize、instructions、分页 tools/list、list_changed、tools/call、isError、延迟、stderr 和异常退出
- [x] 7.2 先编写 STDIO 初始化测试，覆盖 trusted、command 不存在、cwd/env 装配、连接超时、协议不兼容和状态迁移
- [x] 7.3 使用官方 StdioClientTransport 实现 STDIO 连接，command/args 不经 shell，stdout 专供协议、stderr 有界消费
- [x] 7.4 先编写 tools/list 分页/变化测试，验证完整列表原子发布和刷新失败不发布半量工具
- [x] 7.5 实现 STDIO 工具发现、通知和 instructions 快照
- [x] 7.6 先编写 STDIO tools/call 测试，覆盖原始名称/参数、并发不串线、isError、取消、超时和 exactly-once
- [x] 7.7 实现 STDIO 调用、AbortSignal、超时与错误分类，不自动重放可能已发送的业务调用
- [x] 7.8 先编写 STDIO dispose 测试，覆盖停用、删除、扩展关闭、请求取消、正常退出和强制有界清理
- [x] 7.9 实现 Client/Transport/子进程完整释放并验证测试无悬挂句柄

## 8. Streamable HTTP 与 Legacy SSE Connection

- [x] 8.1 创建本地 HTTP fixture，分别支持 Streamable HTTP stateful/stateless、MCP SSE 响应流、headers、session terminate、legacy SSE-only、401/403/5xx 和延迟
- [x] 8.2 先编写 Streamable HTTP 连接测试，覆盖 HTTPS/loopback 策略、同 origin headers、跨 origin redirect 拒绝、连接超时和 Server 元数据
- [x] 8.3 使用官方 StreamableHTTPClientTransport 实现远程连接和静态 header 注入，不在错误/日志中泄漏 URL query/header 值
- [x] 8.4 先编写 stateful/stateless 关闭测试，验证存在 session 时 terminateSession，再关闭 Client
- [x] 8.5 实现远程 session 与 response stream 的有界关闭
- [x] 8.6 先编写 legacy SSE fallback 测试，覆盖显式开启、兼容失败、新 Client、actualTransport、未开启不回退
- [x] 8.7 增加负向回退测试，证明 401/403、TLS/DNS、超时、取消和 5xx 不触发 legacy SSE
- [x] 8.8 实现严格 compatibility 分类和 SSEClientTransport fallback，第一套 Client/Transport 必须先释放
- [x] 8.9 先编写远程 tools/list/tools/call 测试，覆盖分页、list_changed、并发、取消、超时、流断开和不自动重放
- [x] 8.10 实现远程发现与调用，并把 Transport 细节收敛在 Connection/Factory 内

## 9. 动态 ToolRegistry 与 MCP Tool Adapter

- [x] 9.1 先扩充 ToolRegistry 测试，覆盖静态工具、owner 注册、跨 owner 冲突、原子替换失败回滚、owner 下线和一致 list 快照
- [x] 9.2 实现 owner-scoped register/replace/unregister API，保持现有静态 register/lookup/validate/list 兼容
- [x] 9.3 先编写 McpToolAdapter 测试，覆盖 schema、权限、Manager 路由、AbortSignal、Server unavailable 与 result governance
- [x] 9.4 实现继承 BaseTool 的 Adapter，只持有不可变 catalog entry 和 Manager 引用，不持有 Secret/Transport
- [x] 9.5 扩充 ToolRouter 测试，验证 read 免审批、unknown execute 审批、destructive 审批，拒绝时 STDIO/HTTP 均不收到请求

## 10. Manager、Revision 与运行时装配

- [x] 10.1 先编写 McpClientManager 测试，覆盖多 Transport、多 Server、单 Server 故障隔离、逐 owner 发布、instructions、状态订阅和反向调用
- [x] 10.2 实现 Manager、Connection Factory、catalog、instructions、settings snapshot 与 dispose
- [x] 10.3 先编写 revision/config diff 测试，覆盖未变化复用、新增、编辑重建、disable、delete、reconnect 和迟到事件丢弃
- [x] 10.4 实现串行 `applyConfig` 与 revision gate：旧 Connection 先下线工具/instructions再关闭，新连接只可发布最新 revision
- [x] 10.5 增加 workspace trust 变化测试与实现：不可信时保留 Store/设置管理但停止连接，恢复 trusted 后连接最新 enabled 配置
- [x] 10.6 在 `extension.ts` 装配 Store、Manager、设置依赖和后台渐进连接，MCP 失败不得阻塞 Webview、本地工具或 Skill 初始化
- [x] 10.7 将 Manager 注册到 context.subscriptions，补充关键阶段中文日志与秘密泄漏断言

## 11. System Prompt 与 AgentLoop Function Calling

- [x] 11.1 先编写 MCP instructions 测试，覆盖来源边界、稳定顺序、单项/总量截断、与 AGENTS/Skill 并存、禁用/断连动态移除
- [x] 11.2 扩展 SystemPromptContext/buildSystemPrompt，注入 `<mcp_server_instructions>` 并声明其不构成安全授权
- [x] 11.3 让 AgentLoop 每轮读取 Manager instructions 快照，未配置 MCP 时 prompt 结果保持兼容
- [x] 11.4 扩充 AI SDK schema adapter 测试，验证静态与 ready MCP 工具共同进入请求且无 execute callback
- [x] 11.5 编写 STDIO AgentLoop 端到端测试：Function Call → ToolRouter → CodeGraph-like fixture → governed result → MessageStore → 下一轮模型
- [x] 11.6 编写 Streamable HTTP AgentLoop 端到端测试，验证 endpoint/headers 不来自模型参数且 call ID 全链一致
- [x] 11.7 补充本地+STDIO+远程混合调用测试，验证事件顺序、只读并行和含 execute/destructive 时的现有策略

## 12. CodeGraph 验收与整体交付

- [x] 12.1 验证根 `AGENTS.md` 只包含一份既有 CODEGRAPH 标记块且本 Change 不改写项目 MCP 配置文件
- [ ] 12.2 通过设置页 JSON 添加 CodeGraph STDIO 配置，确认 Store 不读取当前 `.mcp.json` 且 CodeGraph Server 由受管理 STDIO Connection 启动
- [ ] 12.3 人工验证 CodeGraph ready 后模型请求出现 namespaced Function Calling 工具，代码结构问题触发 MCP 调用且结果 call ID 正确
- [ ] 12.4 验证 Streamable HTTP 和 legacy SSE fixture 在设置页显示正确配置/实际 Transport、状态与工具数
- [ ] 12.5 验证禁用、删除、连接错误和 untrusted workspace 时 Agent 回退现有文件工具且聊天不中断
- [x] 12.6 运行 MCP 单元/集成/Webview 测试，确认无残留子进程、HTTP server、悬挂句柄与秘密日志
- [x] 12.7 运行 `npm run check-types`、`npm run check-types:webview`、`npm run lint` 和 `npm test`
- [x] 12.8 运行 `npm run compile` 与生产打包，验证四个官方 Client/Transport 入口在 Extension Host 可加载
- [x] 12.9 更新必要架构与用户文档，准确说明 STDIO、Streamable HTTP、legacy SSE fallback、私有 Store 与秘密占位语义
- [x] 12.10 运行 `openspec validate integrate-mcp-tool-management --strict` 并确认所有 artifacts 与 delta specs 通过
