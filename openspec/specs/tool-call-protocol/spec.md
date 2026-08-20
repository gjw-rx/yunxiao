# tool-call-protocol Specification

## Purpose
TBD - created by archiving change phase1-local-tool-calling. Update Purpose after archive.
## Requirements
### Requirement: tool_call SSE event
The local AgentLoop SHALL receive normalized tool calls from the AI SDK model runtime fullStream. Calls for static tools and dynamic MCP tools SHALL use the same Core ToolCall containing call_id, model-visible tool and args. Tool source, Server ID, native MCP tool, Transport and permission SHALL be resolved from trusted registry/catalog metadata and MUST NOT be accepted from the model event.

#### Scenario: AI SDK returns local call
- **WHEN** fullStream contains a complete `fs_read_file` tool-call
- **THEN** AgentLoop emits running state and routes it through ToolRouter

#### Scenario: AI SDK returns MCP call
- **WHEN** fullStream contains `mcp__codegraph__codegraph_explore`
- **THEN** AgentLoop routes the same normalized shape through ToolRouter to the adapter

#### Scenario: Model supplies fake endpoint
- **WHEN** model args include fake URL, command or Server ID
- **THEN** invocation still uses the stored trusted catalog entry

### Requirement: Tool call event emission
The AgentLoop SHALL emit a tool_call EventBus event immediately when a complete toolCall LLMEvent arrives, before execution. The payload SHALL contain call_id, model-visible tool and parsed args for static and MCP calls.

#### Scenario: MCP call event
- **WHEN** stream adapter yields an MCP tool call
- **THEN** EventBus receives its call ID, exposed name and args before validation or protocol invocation

#### Scenario: Mixed calls preserve stream order
- **WHEN** one response contains multiple local and MCP calls
- **THEN** AgentLoop emits one event per call in stream order before applying execution policy

### Requirement: Tool result event forwarding
ChatViewProvider SHALL forward tool_result EventBus events to the Webview for static and MCP tools, containing the governed ToolResult and original model call ID.

#### Scenario: Remote MCP result forwarded
- **WHEN** a remote MCP adapter completes
- **THEN** Webview receives the governed result associated with the same call ID

### Requirement: MCP result continuation
AgentLoop SHALL persist the assistant MCP Function Call and matching governed tool result through the existing history contract, then include both in the next model request. MCP success, error, cancellation and unavailable results SHALL all continue the loop with exactly one matching tool message.

#### Scenario: MCP success continues generation
- **WHEN** tools/call succeeds for call ID `call-1`
- **THEN** the next model request contains the matching tool result and generation can continue

#### Scenario: MCP failure continues generation
- **WHEN** Transport returns a structured error
- **THEN** the next model request contains that matching failure and AgentLoop can re-plan

### Requirement: 工具结果保留 Provider 重放所需的工具名
本地 LLM 消息与持久化消息中的 tool result SHALL 保存 `toolCallId`、`toolName` 和受治理的结果内容。新工具执行完成时 MUST 从实际 model tool call 写入工具名；读取缺少 `toolName` 的旧记录时 SHALL 通过相同 `toolCallId` 的前序 assistant tool call 恢复。恢复后的统一消息 MUST 可分别转换为 OpenAI-compatible tool message 和 Anthropic `tool_result`，且不得改变 ToolRouter 的执行入口。

#### Scenario: 新工具结果写入历史
- **WHEN** 模型调用名为 `fs_read_file` 的工具且 ToolRouter 返回结果
- **THEN** 持久化 tool result 同时包含调用 ID、`fs_read_file` 名称和治理后的内容

#### Scenario: 旧记录恢复工具名
- **WHEN** 历史 tool result 只有调用 ID，且前序 assistant tool call 具有相同 ID 与工具名
- **THEN** 历史加载生成带该工具名的统一 tool message，不修改磁盘上的旧记录

#### Scenario: 孤立旧工具结果无法恢复
- **WHEN** 历史 tool result 缺少工具名且不存在匹配的前序 assistant tool call
- **THEN** 现有历史完整性治理移除或拒绝该孤立结果，不向任何 Provider 发送空工具名

### Requirement: Anthropic 工具往返保持调用身份与顺序
Anthropic tool use 归一化后 SHALL 保留 Provider 调用 ID、工具名和 JSON 输入；对应 tool result SHALL 引用同一调用 ID。多个并行 tool use 的统一事件、ToolRouter 执行结果和下一轮 tool result SHALL 保持既有调用关联，不得按工具名合并不同调用。

#### Scenario: Claude 并行调用同名工具
- **WHEN** Claude 在同一响应中以不同调用 ID 两次调用同名工具
- **THEN** 系统产生两条独立 toolCall，分别执行并以各自调用 ID 返回两个 tool result

