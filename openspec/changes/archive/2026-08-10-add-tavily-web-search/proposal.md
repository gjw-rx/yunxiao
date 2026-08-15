## Why

云效 Agent 目前只能访问工作区和本地工具，无法为需要最新外部资料、官方文档或可引用来源的问题提供检索能力。引入受配置控制的 Tavily 检索服务，使 Agent 能在用户需要时获取结构化的公开网络资料。

## What Changes

- 新增只读本地工具 `web.search`，供 Agent 按查询词检索公开网络资料。
- 首期仅接入 Tavily；通过 VS Code 配置提供启用状态、API Key、默认结果数、超时和搜索深度等 Tavily 参数。
- 默认不提供 Tavily API Key 或其他 Tavily 参数；未完成可用配置时，`web.search` 不发起网络请求，并向 Agent 返回明确的“webSearch 不可用”结构化错误。
- 统一检索结果为标题、URL、摘要、相关性和可选发布时间，继续使用既有工具结果治理机制限制返回内容。
- 不包含网页正文抓取、浏览器自动化、多 Provider 回退或 Provider 自动探测。

## Capabilities

### New Capabilities

- `external-web-search`: 通过显式配置的 Tavily 服务向 Agent 提供受限、结构化的外部网络检索结果。

### Modified Capabilities

- 无。

## Impact

- 新增 `src/tools/web/` 下的搜索工具与 Tavily Provider，实现并注册到 `src/extension.ts`。
- `package.json` 增加 `yunxiaoAgent.webSearch.*` 配置项；不增加新的运行时依赖，复用 Node 全局 `fetch`。
- 新增工具与配置测试，覆盖可用、未配置、认证失败、限流、超时与结果治理场景。
