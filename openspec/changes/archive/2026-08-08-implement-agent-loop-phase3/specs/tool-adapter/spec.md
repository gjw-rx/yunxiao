## ADDED Requirements

### Requirement: ToolSchema 转换为 ToolDefinition
toolAdapter SHALL 提供 `toolSchemaToDefinition(schema: ToolSchema): ToolDefinition` 函数，将 core 层工具定义转换为 LLM 层格式。

#### Scenario: 正常转换
- **WHEN** 输入 ToolSchema（含 name/description/parameters/permissions/site/canParallel）
- **THEN** SHALL 返回 ToolDefinition（仅含 name/description/parameters），丢弃 permissions/site/canParallel 字段

### Requirement: LLMToolCall 转换为 core ToolCall
toolAdapter SHALL 提供 `llmToolCallToCoreToolCall(llmCall: LLMToolCall): ToolCall` 函数，将 LLM 返回的工具调用转换为 core 层格式。

#### Scenario: 正常转换
- **WHEN** 输入 LLMToolCall（id/name/arguments，arguments 为 JSON 字符串）
- **THEN** SHALL 返回 core 层 ToolCall（call_id=id, tool=name, args=JSON.parse(arguments), site='local'）

#### Scenario: arguments 解析失败
- **WHEN** arguments 不是合法 JSON 字符串
- **THEN** SHALL 将 args 设为空对象 `{}`，不抛出异常

### Requirement: ToolResult 转换为 tool 消息内容
toolAdapter SHALL 提供 `toolResultToContent(result: ToolResult): string` 函数，将工具执行结果转换为 tool 消息的 content 字符串。

#### Scenario: 成功结果转换
- **WHEN** 输入 ToolResult（status='success', result='文件内容...'）
- **THEN** SHALL 返回 result 字段的内容作为 content

#### Scenario: 错误结果转换
- **WHEN** 输入 ToolResult（status='error', error='超时'）
- **THEN** SHALL 返回包含错误信息的字符串，格式如 "Error: 超时"

#### Scenario: 取消结果转换
- **WHEN** 输入 ToolResult（status='cancelled', error='用户拒绝执行'）
- **THEN** SHALL 返回包含取消原因的字符串，格式如 "Cancelled: 用户拒绝执行"

### Requirement: 工具列表批量转换
toolAdapter SHALL 提供 `toolSchemasToDefinitions(schemas: ToolSchema[]): ToolDefinition[]` 函数，批量转换工具定义。

#### Scenario: 批量转换
- **WHEN** 输入多个 ToolSchema
- **THEN** SHALL 返回对应数量的 ToolDefinition 数组，仅包含 site='local' 的工具
