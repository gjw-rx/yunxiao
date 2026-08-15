## Context

当前插件的本地工具均通过 `BaseTool`、`ToolRegistry` 和 `ToolRouter` 调用；`read` 权限工具无需审批，并在返回云端前经过统一脱敏与截断治理。项目尚无外部资料检索能力，但 Node 运行时已可使用全局 `fetch`，因此无需为 Tavily 再引入 HTTP 客户端依赖。

本变更将 Tavily 作为唯一检索后端。用户明确要求 Tavily 参数由配置提供，插件不内置凭据或替用户启用服务；缺少必要配置时必须直接向 Agent 表明 webSearch 不可用。

## Goals / Non-Goals

**Goals:**

- 提供可被 Agent 调用的只读 `web.search` 本地工具。
- 通过 `yunxiaoAgent.webSearch.*` 配置显式控制 Tavily 是否可用及其请求参数。
- 返回稳定、最小化且可引用的搜索结果结构，并沿用现有结果治理与工具失败协议。
- 让未配置、认证失败、限流、超时等情形对 Agent 可诊断且不泄露 API Key。

**Non-Goals:**

- 不实现 `web.fetch`、网页正文抓取、浏览器自动化、HTML 转换或缓存。
- 不实现多 Provider、自动选择、自动回退或 MCP 连接。
- 不自动发放、写入或推断 Tavily API Key；不在日志、错误或结果中暴露凭据。

## Decisions

### 1. 使用单一 Tavily Provider，并保留内部 Provider 边界

新增 `WebSearchProvider` 内部接口和 `TavilyWebSearchProvider` 实现；`WebSearchTool` 仅依赖接口。首期在扩展激活时只构造 Tavily 实现。

这使外部响应格式与工具契约解耦，同时避免首期引入 Hermes 的 Provider 注册表、能力选择和回退策略。OpenCode 的 MCP 适配层也证明 Provider 隔离有价值，但本项目不需要 MCP 复杂度。

### 2. 将可用性设为显式配置前置条件

配置包含 `enabled`、`apiKey`、`maxResults`、`searchDepth`、`timeoutMs`、`includeDomains` 和 `excludeDomains`。其中 `enabled=true` 且 `apiKey` 为非空字符串是发起请求的必要条件；插件不提供 Tavily 凭据，也不尝试其他后端。

当条件不满足时，工具 SHALL 返回 `status: error`、`metadata.retryable: false` 和明确错误“webSearch 不可用：请配置 yunxiaoAgent.webSearch.enabled 与 yunxiaoAgent.webSearch.apiKey”。不得发起 HTTP 请求。

可选调优参数使用受限的本地默认值和边界值，以保证模型缺省入参时仍能形成有限请求；这些默认值不是 Tavily 凭据或服务配置。

### 3. `web.search` 是可并行的只读工具

工具 Schema 使用 `permissions: read` 和 `canParallel: true`，因此沿用当前 `ToolRouter` 的只读直通策略，不显示审批卡片。搜索请求不修改本地或远端用户资源。

替代方案是在每次搜索前要求审批，类似 OpenCode。未采用的原因是当前项目的权限模型将只读工具定义为免审批；改变该语义会影响非本变更范围的工具策略。

### 4. 对外部结果执行归一化和最小化

Provider 将 Tavily 响应转为 `{ query, provider, results }`，每个结果只包含 `title`、`url`、`snippet`、`score` 与可选 `publishedAt`。工具不得直接返回 Tavily 原始响应、请求头、API 错误体或未选中的内容字段。

工具将单次 `maxResults` 限定为 1 至 10；随后仍由 `BaseTool.governResult` 执行密钥脱敏和文本截断。系统提示词和工具描述将把返回资料界定为不可信外部内容，不能把其中的指令当成工具或系统指令。

### 5. 失败采用现有 ToolRouter 协议

Provider 对网络错误、非成功 HTTP 状态和无效响应抛出无敏感信息的错误。`ToolRouter` 将其转为结构化 `status: error` 结果；认证和配置错误不可重试，429 和超时可标为可重试。关键路径使用中文日志，日志仅记录查询长度、结果数、状态码类别和耗时。

## Risks / Trade-offs

- [外部搜索结果包含提示注入或不准确信息] → 将结果视为资料而非指令；限制字段并保留来源 URL，促使 Agent 交叉验证。
- [API Key 被写入日志或错误] → 不记录请求头和完整 URL；错误仅返回通用、可行动的中文说明。
- [服务不可用导致 Agent 循环重试] → 缺配置和认证错误明确标为不可重试；对可恢复的限流与超时提供有限重试信号。
- [Tavily 供应商锁定] → 以内部 Provider 接口隔离，但暂不实现第二个后端。
- [结果过大占用上下文] → 限制结果数、仅返回摘要，并使用既有统一治理。

## Migration Plan

1. 发布后默认保持 webSearch 不可用，直至用户显式配置启用项与 Tavily API Key。
2. 已配置的工作区重载扩展后即可使用新工具，无数据迁移。
3. 若发现问题，移除或关闭 `yunxiaoAgent.webSearch.enabled` 即可停止调用；工具仍返回明确不可用错误，不影响其他本地工具。

## Open Questions

- API Key 在首期是否沿用现有 VS Code 设置存储方式，还是另起命令存入 `SecretStorage`？本提案按最小变更假设沿用现有配置风格，但实现前可决定是否提升凭据存储方式。
