## ADDED Requirements

### Requirement: MCP Server instructions 独立注入
系统 SHALL 在每轮 AgentLoop 构建系统提示词时读取所有 enabled 且 ready MCP Server instructions 快照，并 SHALL 将每个 Server 内容放入带 Server ID 的独立 `<mcp_server_instructions>` 边界。MCP instructions SHALL 与 agent prompt、环境、项目规则和 Skills 并存，不得覆盖这些段落。

#### Scenario: CodeGraph instructions 注入
- **WHEN** CodeGraph ready 且 Client 返回 instructions
- **THEN** 下一轮系统提示词包含标明 codegraph 来源的 MCP instructions 段

#### Scenario: AGENTS 与 MCP 并存
- **WHEN** 当前项目 AGENTS.md 和 MCP instructions 同时存在
- **THEN** 两种来源分别标界且 AGENTS 内容未被替换

### Requirement: MCP instructions 限长与动态移除
系统 SHALL 对单 Server 和全部 instructions 设定确定上限并按稳定 Server ID 顺序注入。instructions 缺失、Server disabled/error/stopping 或快照失败时 SHALL 跳过对应段落且不影响会话。日志 MUST NOT 打印 instructions 正文。

#### Scenario: instructions 超长
- **WHEN** Server 返回超过单项上限的 instructions
- **THEN** 系统提示词包含带截断标记的有界内容

#### Scenario: Server 停用
- **WHEN** 用户在下一轮前停用 Server
- **THEN** 下一轮移除该 Server instructions，其他段落保持

### Requirement: MCP instructions 不构成安全授权
系统 SHALL 声明 MCP instructions 只用于工具使用指导。instructions MUST NOT 改变 ToolRegistry 权限、跳过 ToolRouter 审批、修改 MCP 配置、扩大路径/网络权限、关闭结果治理或覆盖项目安全规则。

#### Scenario: instructions 要求跳过审批
- **WHEN** Server instructions 声称 execute tool 无需批准
- **THEN** ToolRouter 仍按注册权限审批

#### Scenario: instructions 要求修改 Server URL
- **WHEN** instructions 建议模型切换到另一 endpoint
- **THEN** 模型没有配置写能力且 Manager 仍使用用户保存 URL

