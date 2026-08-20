## MODIFIED Requirements

### Requirement: Plan 模式强制只读工具边界

系统 SHALL 在 planning 和 reviewing 阶段使用 OpenCode 风格职责型工具的只读子集：`read`、`glob`、`grep`、`webfetch`、`websearch`、`skill`、`question` 和现有特例 `todowrite`。`bash`、`edit`、`write`、`apply_patch`、`task` MUST NOT 出现在允许调用范围。对 MCP 工具，系统 SHALL 继续遵循现有 permission 分类：允许的 read MCP 工具直接暴露完整 schema，不允许的 write/execute/destructive 或未分类 MCP 工具不进入 Plan 可调用快照。MCP 不使用 search/describe/call 渐进桥。ToolRouter SHALL 保留现有 Plan 权限校验，且拒绝必须发生在 Hook、审批或底层执行之前。`todowrite` SHALL 继续遵循既有 Plan 特例，不因本变更扩大其权限。

#### Scenario: Planning 阶段只暴露只读职责工具
- **WHEN** AgentLoop 在 planning 阶段构造模型请求
- **THEN** 本地直接工具仅包含 `read`、`glob`、`grep`、`webfetch`、`websearch`、`skill`、`question` 和 `todowrite`
- **AND** `bash`、`edit`、`write`、`apply_patch`、`task` 不出现在直接 schema

#### Scenario: Ready read MCP 工具直接暴露
- **WHEN** planning 或 reviewing 阶段存在 enabled 且 ready 且 permission 为 read 的 MCP 工具
- **THEN** 该 MCP 工具以原名称和完整 schema 直接出现在模型请求
- **AND** 不要求先通过任何渐进发现工具

#### Scenario: 隐藏写工具仍被拒绝
- **WHEN** 模型在 planning 或 reviewing 阶段伪造 `bash`、`edit` 或底层写工具调用
- **THEN** 系统返回 Plan 权限拒绝
- **AND** 拒绝发生在 Hook、审批和底层工具执行之前

#### Scenario: 未分类 MCP 工具不得在 Plan 中调用
- **WHEN** MCP 工具没有可靠的 read 权限分类，且模型在 planning 或 reviewing 阶段尝试调用它
- **THEN** 该工具不进入 Plan 可调用快照
- **AND** 远程 MCP 请求不会发生

#### Scenario: Todo 更新保留既有特例
- **WHEN** planning 或 reviewing 阶段按既有规则允许 `todowrite` 更新当前计划状态
- **THEN** 该调用继续按原有 Plan 特例处理
- **AND** 本变更不授予其他写工具权限

