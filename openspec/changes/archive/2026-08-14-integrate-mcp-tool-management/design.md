## Context

当前扩展已有独立设置 Webview，左侧分类只有“模型”“Skill”“使用情况”。模型配置通过 `ModelConfigStore` 保存到用户级 `~/.yunForce`，秘密放入 VS Code `SecretStorage`；Skill 配置通过设置页消息协议交给 Extension Host。工具运行时则是静态的：`extension.ts` 激活时创建 `BaseTool` 并注册到 `ToolRegistry`，`AgentLoop` 每轮把 `registry.list()` 转为 Function Calling schema，模型返回 tool call 后统一经过 `ToolRouter` 的参数校验、安全审计、审批、执行与结果治理。

目标不是从工作区读取 `.mcp.json`，而是让用户在插件设置页中直接输入 JSON、管理 MCP Servers，并由插件私有存储作为唯一配置源。配置需要支持本地 STDIO 和远程 HTTP。协议术语必须准确：MCP 当前的远程标准 transport 是 **Streamable HTTP**，它的响应可以使用 SSE 流；旧版 **HTTP+SSE transport** 是另一个已被替代的兼容协议。产品界面因此展示“STDIO”和“Streamable HTTP”两类，远程配置可选择“兼容旧版 SSE”，而不把 Streamable HTTP 与 legacy SSE 当成同一种 transport。

CodeGraph 是首个实际使用场景。它通过 `codegraph serve --mcp` 提供 STDIO MCP Server；CodeGraph 的安装、索引初始化与索引维护不属于本 Change。现有根 `AGENTS.md` CodeGraph 指引保持不变。

该改动同时涉及设置 UI、Webview 消息协议、配置持久化、秘密管理、子进程与网络安全、MCP 生命周期、动态工具注册、Function Calling、AgentLoop 与结果治理，必须在实现前确定单一数据源和清晰调用边界。

## Goals / Non-Goals

**Goals:**

- 在插件设置页提供完整 MCP Server 管理：JSON 新增/批量导入、编辑、删除、启停、重连、状态、错误摘要和工具列表查看。
- 插件私有存储成为 MCP 配置唯一来源；不自动发现或读取项目 `.mcp.json`。
- 支持 STDIO 和 Streamable HTTP；可选兼容仅实现旧 HTTP+SSE transport 的远程 Server。
- 安全保存 STDIO env 与远程 headers：明文只在 Webview 提交到 Host 的单次消息中出现，随后进入 SecretStorage，不落普通文件、不回显、不写日志。
- 完整实现 MCP tools 生命周期：连接、协议协商、instructions、分页 `tools/list`、列表变化、`tools/call`、取消、超时、重连和清理。
- 将 ready MCP Tools 动态桥接为现有 Function Calling，并且所有调用继续经过 `ToolRouter` 唯一执行边界。
- 让不同 Server/Transport 局部失败，不影响聊天、本地工具与其他 MCP Server。
- 提供设置 UI、配置存储、Transport、桥接和 AgentLoop 的分层测试与打包验证。

**Non-Goals:**

- 不读取、写入或监听 `.mcp.json`、`.trae/mcp.json` 等项目级 MCP 文件。
- 不安装或实现 MCP Server，不执行 CodeGraph `init/index/sync`。
- 不支持用户在聊天中让模型新增、修改、启用或删除 MCP Server；配置权只属于设置页用户操作。
- 不把 MCP resources、resource templates、prompts、sampling、elicitation 或 roots 转为模型能力。
- 不实现完整 OAuth/DCR/浏览器回调；首期远程认证使用用户提供的静态 headers。
- 不提供任意自定义 Transport、WebSocket 或服务端 MCP 能力。
- 不把图片、音频或 blob 的 base64 直接放入当前纯文本 ToolMessage；只返回受治理的描述与 metadata。
- 不改变现有本地工具名称、权限和执行语义。

## Decisions

### 1. 使用官方 MCP TypeScript Client，而不是手写 JSON-RPC

使用实现期最新稳定的官方 TypeScript MCP Client 包及其 `Client`、`StdioClientTransport`、`StreamableHTTPClientTransport` 和 `SSEClientTransport`。当前官方 SDK 已把本地与远程 Transport 生命周期、协议协商、request ID、通知、取消和 session 处理封装起来；Harness 只实现配置、安全策略、状态编排与数据适配。

备选方案是直接使用 `child_process.spawn`、fetch 和 EventSource 手写 JSON-RPC。它看似少一个依赖，却需要自行维护 framing、MCP session header、SSE 重连、取消、分页和协议版本兼容，不符合通用 MCP Host 的可靠性要求。

### 2. MCP 设置存储是唯一配置源

新增 `McpConfigStore`，使用与模型配置一致的用户级私有目录：

```text
~/.yunForce/mcp/servers.json
```

Store 持有版本化的非敏感文档，Extension Host 启动时直接读取它。设置页操作通过 Store 的串行写队列完成，成功后通知 `McpClientManager` 应用最新快照。系统不读取当前工作区 `.mcp.json`，也不提供截图中“启用项目级 MCP”的导入开关，避免同一 Server 存在两个来源、覆盖顺序和安全语义。

备选方案包括 VS Code Settings、workspaceState 或项目文件。VS Code Settings 不适合较大的嵌套 JSON 和秘密；workspaceState 不便于用户级跨项目复用；项目文件会重新引入用户已否定的自动文件加载行为。因此选择版本化用户私有文件 + SecretStorage。

### 3. JSON 输入格式明确支持两类 Server

设置页接受常见的 `mcpServers` 包装结构：

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"],
      "env": {},
      "enabled": true
    },
    "remote-docs": {
      "type": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer token"
      },
      "legacySseFallback": true,
      "enabled": true
    }
  }
}
```

STDIO 字段：`type`、`command`、可选 `args/env/cwd/enabled/connectTimeoutMs/callTimeoutMs`。`cwd` 缺省时按当前主工作区根目录解析；显式相对路径同样以工作区为根，绝对/越界路径拒绝。

远程字段：`type`、`url`、可选 `headers/legacySseFallback/enabled/connectTimeoutMs/callTimeoutMs`。URL 必须为 HTTPS；仅 loopback 地址允许 HTTP。静态 headers 绑定配置 URL 的 origin，跨 origin redirect 被拒绝，避免 Authorization 泄漏。

JSON 顶层、每个 Server 以及各字段均禁止未知关键字段，错误必须定位到 `mcpServers.<id>.<field>`。新增/批量导入模式拒绝与既有 ID 冲突，避免静默覆盖；编辑模式只允许更新当前 Server ID，重命名通过显式删除后新增完成。

### 4. Streamable HTTP 与 legacy SSE 明确分层

远程 Server 的主要连接流程固定为：

1. 创建全新 `Client` 与 `StreamableHTTPClientTransport`；
2. 完成连接和 MCP 协商；
3. 仅在配置 `legacySseFallback: true` 且错误被分类为“Transport/协议不匹配”时关闭第一套资源；
4. 创建另一套全新 `Client` 与 `SSEClientTransport`，连接同一配置 URL；
5. 将最终实际 Transport 记录为 `streamable-http` 或 `legacy-sse` 供 UI 展示。

401/403、TLS、DNS、超时、5xx 和用户取消不得触发 SSE 回退，因为这些不是兼容性证据，回退只会隐藏真实错误或重复请求。此决策遵循官方 Client 指南“现代 Streamable HTTP 优先、旧 SSE 使用新 Client 回退”的模式。

UI 用户仍只选择两类配置：STDIO 和 Streamable HTTP；legacy SSE 是远程兼容开关，不是被宣传为现代协议的第三类。

### 5. 所有 env/header 值进入 SecretStorage

`servers.json` 仅保存：Server ID、Transport、command/args/cwd/url、enabled、超时、fallback 标记、env key 列表与 header name 列表。所有 env 和 header 值分别保存到基于 Server ID 与字段名稳定哈希的 SecretStorage key。

设置页快照使用固定占位值 `<已安全保存>` 表示某 key 已有秘密。编辑 JSON 时：

- 占位值表示保留已有秘密；
- 新的非空字符串表示替换 SecretStorage；
- 删除 key 表示删除对应秘密；
- 新 Server 使用占位值或空秘密会被拒绝；
- Host 成功保存后立即丢弃收到的明文对象引用，日志只记录 Server ID 与 key 数量。

把全部 env/header 值都视为秘密，比依赖 `TOKEN/KEY/PASSWORD` 名称猜测更安全，也使规则确定可测。代价是 PATH 等非秘密环境值也不会回显，但用户仍可通过输入新值更新。

### 6. 设置页新增独立 MCP 分类和列表管理

`SettingsSection` 扩展为 `model | skill | mcp | usage`，导航顺序为模型、Skill、MCP、使用情况。MCP 列表页采用克制的管理台布局：标题区展示“MCP 与工具”和私有存储说明，概览行汇总已连接 Server、总 Server 与工具数，搜索框仅过滤当前快照；“当前项目”分区以服务卡片展示状态点、Transport、工具数量、命令或 URL，以及展开、编辑、重连、删除和启停操作。该布局只改变 Webview 呈现与本地筛选，不改变配置来源或 Host 消息协议。

暗色主题下的视觉基调为“开发者控制台”：使用低对比表面和边框承载列表与输入，不为每个元素分配强调色；主操作、次操作和危险操作分别复用插件已有的 VS Code Button、Secondary Button 和 Error token，避免 MCP 页面引入独立色系。空列表展示带明确下一步操作的引导卡片，主操作保持固定最小宽度与单行文本，避免窄内容区出现按钮换行。

点击“添加服务器”后进入独立添加表单：页面提供返回列表操作、配置方式分段标签、JSON 编辑区、校验说明和底部“取消 / 添加并连接”操作。分段标签用于组织表单视觉层级；首期仍只接受既有 `{ "mcpServers": { ... } }` JSON，命令或 URL 的快捷解析不属于本 Change，避免前端界面承诺 Host 尚未支持的保存格式。

MCP 页面由三部分组成：

1. 页面标题与说明：明确配置保存在插件私有存储，不自动读取项目文件；
2. JSON 编辑卡片：默认关闭，点击“添加/导入 JSON”打开；编辑现有 Server 时预填单 Server JSON和秘密占位值；展示实时语法/结构错误，只有 Host 校验成功才保存；
3. Server 管理列表：展示名称、配置 Transport、实际 Transport、状态、工具数量、最近错误摘要，并提供展开详情、编辑、启停、重连与删除。

状态枚举为 `disabled | waiting_workspace_trust | connecting | ready | reconnecting | error | stopping`。ready 行可展开查看发现的 MCP 原始工具名和 description；页面永远不展示 env/header 值。设置页打开时请求一次 MCP 快照，运行时状态变化由 Host 主动推送增量或完整快照。

删除操作需要二次确认；启用和重连为异步操作，消息确认只代表操作已接受，最终状态以后续快照为准。保存有效配置不等待网络/进程连接完成，避免设置 UI 被长连接阻塞。

### 7. Webview 消息协议使用判别联合，不传输运行时对象

新增消息：

```text
Webview → Host
requestMcpSettings
saveMcpServersJson { json, mode, editingServerId? }
setMcpServerEnabled { serverId, enabled }
reconnectMcpServer { serverId }
deleteMcpServer { serverId }

Host → Webview
mcpSettings { servers[] }
mcpSettingsSaved { servers[] }
mcpOperationAccepted { serverId, operation }
mcpSettingsError { operation, message, fieldPath? }
```

Host 对所有字段重新校验，不能信任 Webview TypeScript 类型。`McpServerView` 只包含非敏感配置、秘密是否已配置、运行状态、实际 Transport、工具摘要和有界错误信息。

### 8. Store 更新与运行连接通过串行协调器解耦

`McpConfigStore` 负责事务式持久化；`McpClientManager` 负责运行连接。`extension.ts` 将二者装配，并建立单一串行 `applyMcpConfig` 队列：

- 保存新增/编辑：先完整校验并原子写 Store，再 diff 运行配置；
- 启用：先保存 enabled，再尝试连接；
- 禁用：先在 Manager 下线工具并关闭连接，再保存最终状态；若保存失败则恢复旧配置并按旧配置重连；
- 删除：先停止并下线，再删除非敏感文档与对应 Secrets；
- 重连：不改 Store，只重建该 Server Connection；
- 多个快速操作按消息到达顺序串行，最终运行状态必须对应最新持久化 revision。

每份存储文档带递增 revision。Manager 只应用不小于当前 revision 的快照，避免慢连接完成后覆盖更新配置。

### 9. Manager/Connection/TransportFactory/Adapter 四层隔离

- `McpClientManager`：持有配置 revision、连接表、动态工具目录、instructions 快照、状态订阅与 dispose；提供 `applyConfig/reconnect/callTool/getSnapshot`。
- `McpServerConnection`：一对一拥有 MCP Client 与实际 Transport；负责状态机、握手、工具分页、通知、调用、超时和关闭。
- `McpTransportFactory`：按配置创建 STDIO 或远程连接；实现 Streamable HTTP → legacy SSE 条件回退，返回实际 Transport 类型与统一 close。
- `McpToolAdapter extends BaseTool`：把一个发现的 MCP Tool 转成现有执行单元，通过 Manager 调用，不直接持有凭据、URL、进程或 SDK Client。

协议细节不会进入 `AgentLoop`，`ToolRouter` 也不需要对 Transport 做分支。所有状态迁移使用项目 logger 输出中文日志，只记录 Server ID、阶段、Transport、耗时和错误类别。

### 10. STDIO 与远程连接具有不同生命周期

STDIO：`StdioClientTransport` 按当前工作区展开 cwd 和 SecretStorage env，直接 spawn command/args，不使用 shell；stdout 专供 MCP，stderr 被持续消费并只保留有界尾部。扩展 dispose 或 Server 停用时关闭 Client/transport 并确保子进程退出。

Streamable HTTP：transport 使用 URL 与 SecretStorage headers 建立连接，SDK 管理 session ID 和 SSE 响应流。关闭时若存在 stateful session，先调用 `terminateSession()`，再关闭 Client。静态 header 只应用到匹配 origin 的请求。

Legacy SSE：只作为明确兼容回退；使用独立 Client 和 `SSEClientTransport`，关闭时结束 SSE 与 POST 通道。

工作区不可信时设置 CRUD 仍可用，但任何 enabled Server 保持 `waiting_workspace_trust`，不会启动进程或发起远程连接。工作区恢复 trusted 后 Manager 应用当前 revision 并连接。

### 11. 动态工具注册仍由 ToolRegistry 提供唯一模型快照

扩展 `ToolRegistry` 支持 owner-scoped 原子替换：本地静态工具保持现有注册方式，每个 MCP Server 使用 `mcp:<serverId>` owner。完整新列表先验证名称冲突和 schema，再一次替换 owner 旧列表；失败时不暴露半套工具。

模型工具名采用：

```text
mcp__<normalized-server-id>__<normalized-native-tool-name>
```

只使用 Function Calling 兼容字符；超过保守长度上限时追加稳定哈希。反向目录保存 exposed name、server ID、原始 MCP tool name、schema 与 annotations，执行时查目录而不是拆工具名。冲突拒绝，绝不覆盖。

`AgentLoop` 每轮现有的 `registry.list()` 会自动得到最新快照，无需额外 schema 缓存失效机制。Server disabled/error/stopping 时立即下线工具；历史中尚未执行的调用返回明确 unavailable error。

### 12. 权限与并行策略采用保守映射

MCP `inputSchema` 原样进入 `ToolSchema.parameters`，缺失时使用不允许额外字段的空对象 schema。本地校验先于协议调用。

权限映射：

- `destructiveHint === true` → `destructive`；
- 否则 `readOnlyHint === true` → `read`；
- 其他 → `execute`。

模型参数不能改变权限、Server、Transport、URL 或 command。未知工具默认审批；只有明确只读且 `openWorldHint !== true` 的工具允许 AgentLoop 并行。远程/STDIO 来源不影响权限规则。

### 13. Function Calling 端到端只有一条执行链

```text
SettingsPage JSON
  → Webview message
  → McpConfigStore（非敏感文件 + SecretStorage）
  → McpClientManager.applyConfig(revision)
  → TransportFactory（STDIO / Streamable HTTP / legacy SSE fallback）
  → MCP connect / instructions / tools/list
  → McpToolAdapter 原子注册 ToolRegistry
  → AgentLoop registry.list()
  → AI SDK Function Calling schema
  → 模型 tool call
  → LLMEvent(toolCall)
  → Core ToolCall(call_id, exposedName, args)
  → ToolRouter：lookup → validate → audit → approval
  → McpToolAdapter.execute()
  → Manager.callTool(serverId, nativeName, args)
  → MCP tools/call
  → CallToolResultNormalizer
  → BaseTool.governResult()
  → ToolResult / EventBus / MessageStore
  → 下一轮模型继续生成
```

AI SDK tool definition 不设置 execute 回调，否则会绕过审批、审计、取消和结果治理。模型 call ID 与 SDK JSON-RPC request ID 独立，由一次 adapter Promise 关联，每个模型 call ID 最多产生一个终态结果。

### 14. instructions 与工具结果都视为外部不可信内容

`Client` 连接后取得 Server instructions，Manager 按 Server 保存不可变、有长度上限的快照。`buildSystemPrompt` 将其放在：

```text
# MCP Server Instructions
<mcp_server_instructions server="...">
...
</mcp_server_instructions>
```

段落明确声明 instructions 只能指导工具使用，不能改变 Harness 权限、审批、路径、网络和结果治理。它与 AGENTS.md 项目规则并存，不写入消息历史。Server disabled/error 后下一轮移除对应 instructions。

CallToolResult 归一化规则：text 原样进入文本段；structuredContent 序列化为 JSON；text resource 和 resource link 保留 URI/MIME；image/audio/blob 只提供类型、大小和 MIME 描述，不传 base64；未知类型使用占位并记录 metadata。`isError: true` 转本地 error。所有内容最终通过 `BaseTool.governResult()` 脱敏和截断。

### 15. 远程与本地失败统一但不盲目重放

错误类别至少包括：配置校验、Secret 缺失、workspace untrusted、spawn、DNS/TLS、HTTP auth、HTTP status、transport mismatch、协议协商、工具发现、tool `isError`、超时、取消、连接关闭和结果归一化。

连接与 `tools/list` 等控制面可做有界重试；一旦 `tools/call` 可能到达 Server，系统不得自动重放，因为工具可能有副作用。失败作为同一 call ID 的结构化 ToolResult 回传模型，由模型重新规划。

Server 异常退出或远程流断开时标记 error、原子下线工具/instructions 并推送设置页状态。首期不做无限后台重连；用户可点击重连，控制面也可以执行次数有界的瞬时恢复。

### 16. 测试采用 UI、Store、Transport、Bridge 四层

- UI：MCP 导航、JSON 编辑、字段错误、列表、状态、秘密不回显、启停/重连/删除、窄布局和无障碍。
- Store：新增/批量导入、编辑、冲突、原子写、revision、秘密拆分/保留/替换/删除、非法 JSON 不改变旧配置。
- STDIO fixture：initialize、instructions、分页 tools/list、list-changed、tools/call、stderr、超时、取消、异常退出和进程清理。
- HTTP fixture：Streamable HTTP stateful/stateless、headers、401/403、session close、SSE 流、compatibility mismatch 与 legacy SSE fallback。
- Registry/Router：owner 原子替换、命名冲突、权限审批、只读并行、Server 下线和失效调用。
- AgentLoop：从模型 schema 到 MCP tools/call，再到同 call ID tool result 的完整闭环。
- 打包：生产 esbuild 后在 VS Code Extension Host 中实际加载两类 Client Transport。

## Risks / Trade-offs

- [JSON 设置对普通用户不够友好] → 提供模板、语法高亮/等宽编辑、字段级错误路径和列表管理；首期保持单一 JSON 输入，不同时维护复杂表单 schema。
- [把 env/header 全部当秘密导致编辑时不可见] → 使用明确占位和“保留/替换/删除”语义；安全优先于无差别明文回显。
- [Streamable HTTP 与 SSE 名称容易继续混淆] → UI 只显示标准 Transport 名称，并把 legacy SSE 标为兼容回退和实际连接类型。
- [静态 headers 无法覆盖 OAuth Server] → 明确首期非目标；401 展示认证错误，不伪装成 transport mismatch。
- [用户级配置跨项目，但 STDIO cwd 依赖当前项目] → 每个 Extension Host 按当前主工作区创建独立连接；默认 cwd 为当前工作区；无工作区或不可信时不连接。
- [远程 endpoint 可访问内网或不可信内容] → endpoint 只能由设置页用户配置，模型不能修改；仅 HTTPS/loopback HTTP，跨 origin redirect 拒绝，结果仍按外部不可信内容治理。
- [MCP annotations 可能谎报只读] → 未声明默认 execute；保留审批与 Server 来源。完全防御恶意 Server 不现实，设置页需提示只连接可信 Server。
- [动态工具与 instructions 增加 token] → 只发布 enabled+ready Server，instructions 限长，沿用请求估算与上下文压缩。
- [Server 快速配置变化造成旧连接回写状态] → Store revision + Manager 串行 apply，状态事件携带 revision，过期事件丢弃。
- [多个 Server 工具名归一化冲突] → 命名空间、稳定哈希与注册前全量冲突校验，禁止静默覆盖。
- [关闭 stateful HTTP session 或子进程失败] → 有界 terminate/close，超时后强制清理并记录本地诊断，不阻塞扩展停用。

## Migration Plan

1. 创建新 MCP 配置类型、JSON 校验器、秘密占位协议与 `McpConfigStore`，以测试固定持久化边界。
2. 扩展 Webview 判别联合消息类型和设置依赖，先完成 MCP 设置页列表/JSON 编辑的静态与宿主协议测试。
3. 引入官方 MCP Client，分别实现 STDIO 与 Streamable HTTP fixture/Connection；再增加受控 legacy SSE fallback。
4. 实现动态 ToolRegistry owner、MCP Tool Adapter、结果归一化和 Manager，不接入 Extension 激活主链前完成单元/集成测试。
5. 在 `extension.ts` 装配 Store、Manager 和设置操作串行队列，后台连接 enabled Servers，并把状态推送设置页。
6. 接入 instructions 与 AgentLoop Function Calling 端到端链路。
7. 通过设置页手工导入 CodeGraph STDIO JSON，验证工具发现和调用；不依赖或读取当前 `.mcp.json`。
8. 运行类型、lint、测试、编译与生产打包验证。

回滚时移除 MCP 设置分类、Manager 装配和 SDK 依赖即可恢复静态工具模式；`~/.yunForce/mcp/servers.json` 与 SecretStorage 数据保留，用户升级回来后仍可使用。实现不迁移当前工作区 `.mcp.json`，因此不会删除或改写用户现有文件。

## Open Questions

- 首期是否需要展示每个 Server 的完整已发现工具 schema？本设计默认只展示名称与 description，避免设置页被大 JSON 淹没；详细 schema 可后续按需增加。
- 是否需要支持 `${workspaceFolder}` 等变量插值？本设计只定义 cwd 缺省/相对路径语义，不在 args/env 中做隐式模板展开，以免形成第二套 shell/变量语言。
- 是否需要允许非 loopback 明文 HTTP？本设计默认拒绝，若企业内网有明确需求，应另加显式风险开关和安全规范，而不是首期静默放开。
