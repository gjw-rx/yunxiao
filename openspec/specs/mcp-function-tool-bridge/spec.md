# mcp-function-tool-bridge Specification

## Purpose
定义 MCP 工具到 Function Calling 的桥接：工具名稳定映射、schema 转换、权限保守映射、统一路由、call ID 一致性、CallToolResult 归一化与统一治理、动态可用性与 instructions 快照。

## Requirements

### Requirement: MCP 工具名稳定映射
Bridge SHALL 将 MCP 工具映射为 `mcp__<server>__<tool>` 模型名称，并 SHALL 保存 exposed name、Server ID 与原始 MCP tool name 的不可变目录项。名称 MUST 符合 Function Calling 字符与保守长度限制；归一化/截断 SHALL 稳定，最终冲突 MUST 被拒绝且不得覆盖。

#### Scenario: CodeGraph 名称
- **WHEN** Server ID 为 codegraph 且工具名为 codegraph_explore
- **THEN** 模型名称为 `mcp__codegraph__codegraph_explore` 且目录保留原始名称

#### Scenario: 超长名称
- **WHEN** 组合名称超过长度上限
- **THEN** Bridge 生成带稳定哈希后缀的合规名称且重复发现结果一致

#### Scenario: 名称冲突
- **WHEN** 两个原始标识归一化后冲突
- **THEN** 后注册项被拒绝且既有工具保持不变

### Requirement: MCP schema 转换
Bridge SHALL 使用 MCP Tool description 与 inputSchema 构造唯一 ToolSchema，并 SHALL 由现有 adapter 转为 Function Calling schema。缺失 inputSchema SHALL 使用禁止额外字段的空对象 schema。description SHALL 标识来源 Server，Bridge MUST NOT 维护第二份手写参数 schema。

#### Scenario: 保留 query 约束
- **WHEN** MCP 工具要求必填字符串 query
- **THEN** 模型 Function Calling schema 保留该必填约束

#### Scenario: 缺失 schema
- **WHEN** MCP Tool 未提供 inputSchema
- **THEN** 模型工具只接受空对象而不是任意输入

### Requirement: MCP 权限保守映射
Bridge SHALL 将 destructiveHint true 映射为 destructive；否则 readOnlyHint true 映射为 read；其余映射为 execute。Bridge MUST NOT 根据工具名或 Transport 猜测权限。只有明确只读且非 open-world 的工具才 SHALL 声明可并行。

#### Scenario: 只读远程工具
- **WHEN** Streamable HTTP Tool 声明 readOnlyHint true 且非 open-world
- **THEN** ToolSchema 为 read 并可按现有只读并行策略执行

#### Scenario: 未分类 STDIO 工具
- **WHEN** STDIO Tool 没有 annotations
- **THEN** ToolSchema 为 execute 且调用前需要审批

#### Scenario: destructive 优先
- **WHEN** Tool 同时声明 readOnlyHint 和 destructiveHint true
- **THEN** 本地权限为 destructive

### Requirement: MCP Function Call 统一路由
模型调用 exposed MCP 工具后，AgentLoop SHALL 使用现有 LLMEvent 与 Core ToolCall 流程并交给 ToolRouter。ToolRouter 完成 lookup、JSON Schema 校验、安全审计和必要审批后，McpToolAdapter 才能调用 Manager。AI SDK tool definition MUST NOT 直接执行 MCP。

#### Scenario: CodeGraph 调用成功路由
- **WHEN** 模型调用 `mcp__codegraph__codegraph_explore` 且 query 合法
- **THEN** ToolRouter 通过后 Manager 对原始 `codegraph_explore` 发起一次 tools/call

#### Scenario: 参数校验失败
- **WHEN** 模型遗漏必填 query
- **THEN** 本地返回结构化 validation error 且 MCP Server 不收到请求

#### Scenario: 审批拒绝
- **WHEN** execute MCP 工具的审批被用户拒绝
- **THEN** ToolRouter 返回 cancelled 且所有 Transport 都不发送 tools/call

### Requirement: call ID 一致性
Bridge SHALL 原样保留模型 call ID，用于 ToolCall、EventBus、MessageStore 与下一轮 tool result。MCP SDK request ID SHALL 独立管理且不得假定与模型 call ID 相同。每个模型 call ID SHALL 至多产生一个终态结果。

#### Scenario: 成功结果回传
- **WHEN** call ID `call-42` 的 MCP 工具成功
- **THEN** Webview 状态、持久化消息和下一轮模型结果均关联 `call-42`

#### Scenario: 并发调用不串 ID
- **WHEN** 两个 MCP 调用返回顺序相反
- **THEN** 每个结果仍关联自己的模型 call ID

### Requirement: CallToolResult 归一化
Bridge SHALL 确定性转换 MCP CallToolResult：保留 text；序列化 structuredContent；包含 text resource 与 resource link 的 URI/MIME；对 image/audio/blob 与未知类型返回安全描述和 metadata，不得内联无界 base64。`isError: true` SHALL 转为本地 error。

#### Scenario: 文本与结构化内容
- **WHEN** MCP 返回 text 和 structuredContent
- **THEN** 模型结果按稳定标签包含文本与 JSON

#### Scenario: MCP 业务错误
- **WHEN** MCP 返回 isError true 和错误文本
- **THEN** 本地 ToolResult status 为 error 且内容经过治理

#### Scenario: 图片不上传 base64
- **WHEN** MCP 返回 image data
- **THEN** 模型只收到 MIME/大小描述和 unsupported metadata，不包含原始 base64

### Requirement: MCP 结果统一治理
所有归一化 MCP 结果 SHALL 在进入模型上下文前经过 BaseTool 统一治理，应用二进制防护、秘密脱敏、行数、字节数和字符上限，并附加 redacted/truncated metadata。Bridge MUST NOT 建立绕开 ToolRouter 或 governResult 的结果通道。

#### Scenario: 远程结果含 Token
- **WHEN** Streamable HTTP ToolResult 含高置信度 token 赋值
- **THEN** 发送给模型的内容已脱敏且 metadata.redacted 为 true

#### Scenario: CodeGraph 结果过大
- **WHEN** CodeGraph 文本超过统一结果上限
- **THEN** 模型收到带截断标记的有界内容且 metadata.truncated 为 true

### Requirement: MCP 工具动态可用性
Bridge SHALL 只发布 enabled 且 ready Server 的当前工具快照。Server disabled、error、stopping、删除或工具列表移除时 SHALL 原子下线相应 exposed tools。历史中已生成但执行时失效的调用 SHALL 返回 unavailable error，且不得按名称改路由到其他 Server。

#### Scenario: connecting 不暴露工具
- **WHEN** AgentLoop 构建请求时 Server 仍 connecting
- **THEN** 该 Server 工具不出现在模型 schema，本地工具正常出现

#### Scenario: 执行前 Server 被停用
- **WHEN** 模型已生成 MCP call 但用户在执行前停用 Server
- **THEN** 调用返回 unavailable 且不调用任何同名 Server

### Requirement: MCP instructions 快照
Bridge SHALL 提供 ready Servers instructions 的不可变快照，保留 Server ID 并应用单项/总量上限。状态或 revision 变化后下一轮 SHALL 使用最新快照；instructions MUST NOT 写入消息历史或伪装为用户消息。

#### Scenario: ready Server 提供 instructions
- **WHEN** MCP 连接返回非空 instructions
- **THEN** Bridge 提供带 Server 来源的受限快照供系统提示词使用

#### Scenario: Server 停用
- **WHEN** 用户停用提供 instructions 的 Server
- **THEN** 下一轮快照不再包含该 Server instructions
