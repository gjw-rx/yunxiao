## ADDED Requirements

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
