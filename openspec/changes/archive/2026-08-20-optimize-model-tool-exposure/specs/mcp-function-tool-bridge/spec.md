## MODIFIED Requirements

### Requirement: MCP Function Call 统一路由

模型直接调用 MCP 工具后，AgentLoop SHALL 使用现有 LLMEvent 与 Core ToolCall 流程，并以注册的 MCP 工具名和参数交给 ToolRouter。ToolRouter 完成 lookup、Plan 权限、Hook、JSON Schema 校验、安全审计和必要审批后，McpToolAdapter 才能调用 Manager。AI SDK tool definition MUST NOT 直接执行 MCP。

#### Scenario: CodeGraph 调用成功路由
- **WHEN** 模型直接调用 `mcp__codegraph__codegraph_explore` 且 query 合法
- **THEN** AgentLoop 将底层调用交给 ToolRouter
- **AND** ToolRouter 校验通过后由 Manager 调用 `codegraph` Server 的 `codegraph_explore`
- **AND** 结果使用原模型 tool-call ID 回传

#### Scenario: 参数校验失败
- **WHEN** 模型提交的 MCP 参数不符合当前快照中的 inputSchema
- **THEN** ToolRouter 返回结构化校验错误
- **AND** Manager 不发送远程 MCP 请求

#### Scenario: 审批拒绝
- **WHEN** MCP 工具权限要求审批且用户拒绝
- **THEN** ToolRouter 返回审批拒绝结果
- **AND** McpToolAdapter 不执行远程调用

### Requirement: MCP 工具动态可用性

Bridge SHALL 只将 enabled 且 ready Server 的当前全部工具纳入新 Agent run 的 MCP 工具快照，并 SHALL 将这些工具完整、直接转换为模型 schema。MCP 工具不使用本地职责型工具的隐藏、聚合或渐进披露策略。Server disabled、断开或重连导致工具目录变化时，Bridge SHALL 原子更新完整注册目录，并 SHALL 从下一个 run 起反映到模型快照。历史中已生成但执行时失效的 MCP 调用 SHALL 返回明确 unavailable 错误，MUST NOT 静默路由到其他同名工具。

#### Scenario: Ready MCP 工具全部直接暴露
- **WHEN** AgentLoop 创建运行快照时 MCP Server enabled 且 ready
- **THEN** 该 Server 当前发布的每个工具都出现在模型请求中
- **AND** 每个工具保留原 MCP 名称、描述和 inputSchema

#### Scenario: connecting 不暴露工具
- **WHEN** AgentLoop 创建运行快照时 MCP Server 仍处于 connecting
- **THEN** 该 Server 工具不出现在模型 schema 或 MCP 快照中
- **AND** 本地 13 个职责型工具仍可正常使用

#### Scenario: 执行前 Server 被停用
- **WHEN** MCP 工具存在于当前运行快照，但 Server 在执行前被停用
- **THEN** 该调用返回明确 unavailable 错误
- **AND** 系统不路由到其他同名工具或 bash

