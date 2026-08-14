## Why

当前 Harness 只能使用进程内静态注册的本地工具，设置页也没有 MCP 管理入口，用户无法通过插件界面配置、启停和诊断 MCP Server。需要新增插件私有的 MCP 配置与运行时，把用户在设置页输入的 JSON 转换为 STDIO 或远程 Streamable HTTP 连接，并将动态发现的 MCP Tools 安全桥接为模型 Function Calling。

## What Changes

- 在现有独立设置页增加“MCP”分类，并以浅色管理台风格提供概览统计、搜索、项目 Server 卡片和独立添加表单；保留 JSON 导入/新增、编辑、删除、启停、重连/刷新、连接状态、错误摘要、Transport 类型和已发现工具数量展示。
- MCP 配置由插件私有存储管理，不读取项目根 `.mcp.json`，也不提供项目级 MCP 文件自动导入开关。用户通过设置页保存或启用配置即构成明确授权。
- JSON 输入采用常见的 `{ "mcpServers": { ... } }` 结构，支持一次导入一个或多个 Server，并在整体写入前完成 JSON 语法、Server ID、Transport 字段和重复项校验。
- 支持两类运行模式：本地 `stdio`；远程 `streamable-http`。远程模式可显式启用 legacy SSE compatibility，由客户端先尝试 Streamable HTTP，失败后使用全新 Client 回退旧 HTTP+SSE transport。
- 对 STDIO 配置支持 `command`、`args`、`env`、可选 `cwd`；对远程配置支持 `url`、静态请求 `headers`、可选 legacy SSE 回退和连接超时。配置中的 env 值与 header 值按秘密处理，不以明文回传 Webview 或写入普通配置文件。
- 新增 MCP Client Runtime，完成连接、协议协商、`tools/list` 分页和变化监听、`tools/call`、取消、超时、断连、重连与清理；不同 Server 与 Transport 之间相互隔离。
- 新增 MCP Tool → Function Calling 桥接，将 MCP 名称、描述与 `inputSchema` 动态注册到 `ToolRegistry`，并沿现有 `AgentLoop → ToolRouter → BaseTool` 链执行，保留参数校验、安全审计、审批、结果治理和 call ID 关联。
- 接收 MCP Server instructions 并以独立来源段注入系统提示词；保留现有 `AGENTS.md` CodeGraph 指引，不由本 Change 安装、初始化或维护 CodeGraph 索引。
- 将 MCP 文本、结构化内容和资源结果归一化为受治理的工具结果；协议错误、远程 HTTP 错误、认证错误、进程失败、`isError`、超时与取消均转换为结构化结果。
- 不在本 Change 中把 MCP resources、prompts、sampling、elicitation 或 OAuth 授权流程暴露为模型能力；范围聚焦 MCP tools 与静态凭据连接。

## Capabilities

### New Capabilities

- `mcp-settings-management`: 设置页 MCP 分类、JSON 导入/编辑、私有持久化、秘密分离、Server 启停、删除、刷新和运行状态展示。
- `mcp-client-runtime`: STDIO、Streamable HTTP 与可选 legacy SSE 回退的连接生命周期、工具发现、调用、取消、重连与故障隔离。
- `mcp-function-tool-bridge`: MCP Tool 到模型 Function Calling 的稳定转换、反向路由、instructions 注入和 CallToolResult 归一化。

### Modified Capabilities

- `settings-page`: 设置导航从模型、Skill、使用情况扩展为包含 MCP，并通过宿主消息协议管理 MCP 快照与操作反馈。
- `plugin-configuration-management`: 插件私有配置新增 MCP Server 非敏感元数据存储，并将 STDIO env 值和远程 header 值保存在 SecretStorage。
- `local-tool-registry`: 支持按 MCP Server owner 动态原子注册、替换和下线工具。
- `ai-sdk-tool-schema-adapter`: 将动态 MCP 工具与本地工具共同转换为 Function Calling schema，且不在 AI SDK 回调内执行。
- `tool-call-protocol`: 模型发起的 MCP Function Call 经统一 ToolCall/ToolRouter 链调用对应 MCP Server，并以同一 call ID 回传下一轮模型。
- `security-boundary`: 用户管理的 MCP 配置、STDIO 进程、远程 URL/headers、工具权限和返回内容均受本地信任、审批与结果治理约束。
- `tool-execution-failure-handling`: 两类 Transport 的连接、认证、HTTP、协议、超时、取消和 Server 错误统一转为结构化失败，避免副作用调用盲目重放。
- `project-rules-injection`: ready MCP Server 的 instructions 以独立、限长且低于 Harness 安全规则的段落进入每轮系统提示词。

## Impact

- 主要影响 `src/webview-ui/components/settings/SettingsPage.tsx`、`src/webview-ui/protocol.ts`、`src/chatPanel.ts`、`src/extension.ts`、`src/agent/agentLoop.ts`、`src/agent/systemPrompt.ts`、`src/core/toolRegistry.ts`、`src/core/toolRouter.ts` 以及新增 `src/mcp/`、`src/config/mcpConfigStore.ts` 与 `src/tools/mcp/`。
- 需要新增官方 MCP TypeScript Client SDK 依赖，并验证 STDIO 与 Streamable HTTP Client Transport 在 VS Code Extension Host/esbuild 中可用。
- MCP 非敏感配置预计保存于用户级 `~/.yunForce/mcp/servers.json`，秘密值保存于 VS Code SecretStorage；配置跨项目可见，但每个扩展实例按当前工作区建立自己的运行连接。
- 新增 Webview ↔ Extension Host MCP 设置消息协议和较大范围的设置页 UI/样式/测试变化。
- 远程 MCP 会新增外部网络访问面；STDIO 会新增受管理子进程执行面。模型不能新增或修改 Server 配置，所有端点、命令和凭据只能由用户在设置页管理。
- 模型可见工具集合由激活时静态固定扩展为“本地静态工具 + 当前已启用且 ready 的 MCP 动态工具”，现有本地工具行为保持兼容。
