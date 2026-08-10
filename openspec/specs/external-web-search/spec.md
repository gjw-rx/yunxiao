## ADDED Requirements

### Requirement: Agent can search external web sources through Tavily
系统 SHALL 向 Agent 注册名为 `web.search` 的只读、可并行本地工具。该工具 SHALL 接收非空 `query`，并支持受限的 `maxResults`、`searchDepth`、`includeDomains` 和 `excludeDomains` 参数；它 SHALL 仅通过已配置的 Tavily 服务检索公开网络资料。

#### Scenario: Successful external search
- **WHEN** Agent 以有效查询调用 `web.search`，且 webSearch 已启用并具有 Tavily API Key
- **THEN** 系统 SHALL 调用 Tavily 并返回包含查询词、Provider 标识和按相关性排序结果的成功工具结果

#### Scenario: Search result parameter is bounded
- **WHEN** Agent 为 `maxResults` 提供低于 1 或高于 10 的值
- **THEN** 系统 SHALL 在发起 Tavily 请求前拒绝该调用或将值约束至 1 至 10 的支持范围

### Requirement: Tavily availability is configured explicitly
系统 SHALL 提供 `yunxiaoAgent.webSearch.*` 配置项，用于配置启用状态、Tavily API Key、默认结果数、搜索深度、超时、包含域名和排除域名。系统 MUST NOT 内置、生成、记录或自动提供 Tavily API Key。

#### Scenario: Tavily configuration enables search
- **WHEN** `yunxiaoAgent.webSearch.enabled` 为 true 且 `yunxiaoAgent.webSearch.apiKey` 为非空值
- **THEN** 系统 SHALL 将 webSearch 视为可用，并使用配置的 Tavily 参数构建搜索请求

#### Scenario: Tavily configuration is absent
- **WHEN** webSearch 未启用或 Tavily API Key 未配置
- **THEN** `web.search` SHALL 不发起网络请求，并返回说明当前 webSearch 不可用及所需配置项的结构化错误

### Requirement: Search output is safe and normalized
系统 SHALL 将 Tavily 响应归一化为标题、URL、摘要、相关性评分和可选发布时间；系统 MUST NOT 向 Agent 返回 API Key、认证头、Tavily 原始错误体或未经选择的原始响应字段。结果 SHALL 经过既有工具结果脱敏与截断治理。

#### Scenario: Search response is normalized
- **WHEN** Tavily 返回一个或多个搜索结果
- **THEN** Agent 接收的每条结果 SHALL 仅包含允许的归一化字段和可引用 URL

#### Scenario: Provider request fails
- **WHEN** Tavily 请求发生认证失败、限流、超时、网络失败或无效响应
- **THEN** 系统 SHALL 返回不含凭据的结构化工具错误，并记录包含工具名和耗时的中文诊断日志
