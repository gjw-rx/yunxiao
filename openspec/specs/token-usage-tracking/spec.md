## ADDED Requirements

### Requirement: LLM usage 完整解析与透传
流式响应解析器 SHALL 解析 usage 中的 `prompt_tokens`、`completion_tokens`、`total_tokens` 与 `reasoning_tokens`(provider 提供时),并将其实时通过 `token_usage` 事件透传给前端。`input_length` 字段 SHALL 反映本次请求的真实 prompt token 数:优先取 `prompt_tokens`,缺失时 SHALL 使用估算器对请求体(system prompt + 历史消息 + 用户输入 + 工具定义)估算,不得硬编码为 0。

#### Scenario: usage 含完整字段
- **WHEN** 流式响应末尾的 usage chunk 包含 prompt_tokens=100、completion_tokens=50、total_tokens=150、reasoning_tokens=20
- **THEN** 解析器产出 usage 事件携带全部四个字段,`token_usage` 事件载荷中 `total_tokens=150`、`reasoning_tokens=20`、`input_length=100`

#### Scenario: usage 缺少 reasoning_tokens
- **WHEN** provider 返回的 usage 只有 prompt_tokens 与 completion_tokens,无 reasoning_tokens
- **THEN** 系统对本次流中累积的 reasoning 增量文本估算 reasoning token,并以 `source=estimated` 标记

#### Scenario: usage 缺失时按请求体估算 input_length
- **WHEN** 响应未携带 usage 数据,但 LLM 请求体包含 system prompt、历史消息、用户输入与工具定义
- **THEN** `input_length` 等于估算器对完整请求体的估算值,且标注 `source=estimated`

### Requirement: 每步 token 记账与四类拆分
AgentLoop 每步 LLM 调用结束时 SHALL 记录一笔 token 账,包含输入侧的真实/估算 token 与输出侧的四类拆分:思考(reasoning)、工具调用(tool calls)、模型回复(model output)、用户输入(user input)。拆分规则:思考优先取 usage 的 `reasoning_tokens`,缺失时对 reasoning 增量文本估算;工具调用对每个 toolCall 的 `name + arguments` 估算;模型回复优先按 `completion_tokens - reasoning_tokens - 工具调用估算` 计算(结果小于 0 时对正文文本估算);用户输入 SHALL 采用分摊法,按估算占比把权威 `prompt_tokens` 分摊到用户消息(`用户输入 = prompt_tokens × 估算(用户消息) / 估算(完整请求体)`),保证四类之和与总量自洽。每条数字 SHALL 携带 `source` 标记(`usage` 或 `estimated`)。

#### Scenario: 无工具调用的回复
- **WHEN** 一步 LLM 调用返回正文与 usage(completion_tokens=50、reasoning_tokens=20、prompt_tokens=100),无工具调用
- **THEN** 该步记账为 思考=20(usage)、工具调用=0、模型回复=30(计算值)、用户输入=分摊值(估算比例),并全部落账

#### Scenario: 含工具调用的回复
- **WHEN** 一步 LLM 调用返回 2 个 toolCall 与 usage(completion_tokens=80、reasoning_tokens=20),无正文
- **THEN** 工具调用 token 等于两个 toolCall 的 name+arguments 估算之和,模型回复按剩余值计算(可能为 0),思考=20

#### Scenario: 四类之和与总量自洽
- **WHEN** 某步的 usage 为 prompt_tokens=100、completion_tokens=50,且用户消息估算占比为 30%
- **THEN** 用户输入=30、上下文=70(100−30)、四类(思考+工具调用+模型回复+用户输入)与总量(150)对应的 input 侧加总后自洽,上下文单独展示

#### Scenario: 估算结果标记来源
- **WHEN** 某分类数字来自估算而非 usage
- **THEN** 该数字的 `source` 为 `estimated`,UI 据此标注

### Requirement: token 账随消息持久化与恢复
存储层消息 SHALL 支持可选 token 记账字段:assistant 消息可携带该步 `tokenUsage`(真实 usage + 四类拆分 + source),用户消息可携带 `inputTokens`(分摊值,含分摊比例来源标记)。历史重载时 SHALL 基于消息数组恢复会话累计;无 token 字段的旧消息 SHALL 按内容估算补齐展示(不回写存储)。新建会话 SHALL 从零累计。

#### Scenario: 会话累计跨步骤
- **WHEN** 一个 run 完成 3 步 LLM 调用,每步记账分别落库
- **THEN** 会话累计等于 3 笔账之和,包含 total、reasoning、toolCalls、modelOutput、userInput 与上下文六类汇总

#### Scenario: 历史重载恢复累计
- **WHEN** 会话消息被从 workspaceState 重新加载,消息携带 tokenUsage 字段
- **THEN** 前端按消息重新聚合出会话累计,与保存前一致

#### Scenario: 旧消息无 token 字段
- **WHEN** 加载的历史消息没有 tokenUsage/inputTokens 字段
- **THEN** 系统按消息内容估算补齐展示,标记 `source=estimated`,且不写回存储

#### Scenario: 新建会话清零
- **WHEN** 用户点击"新建会话"并开始新对话
- **THEN** 会话累计从零开始,不包含旧会话的 token 数据

### Requirement: 会话级 token 消耗展示
UI SHALL 展示当前会话的累计 token 消耗,包含总量、四类拆分(思考/工具调用/模型回复/用户输入)与上下文占比,并明确标注「四类不含上下文」;估算数字 SHALL 与真实数字以不同样式或标注(如"约")区分。展示为最小可用版本:沿用现有每轮 token 操作栏,新增会话级累计条。会话级汇总 SHALL 在 run 结束时通过 `session_token_usage` 事件推送,历史重载时由前端按消息聚合,并覆盖会话页。成本/价格换算与按模型分组统计 SHALL NOT 在本期实现。

#### Scenario: run 结束推送汇总
- **WHEN** AgentLoop 的 run 正常完成
- **THEN** 系统发射 `session_token_usage` 事件,payload 包含会话级 total、四类拆分与上下文,前端更新累计条

#### Scenario: 估算与真实区分展示
- **WHEN** 会话累计中同时存在 source=usage 与 source=estimated 的数字
- **THEN** 前端分别标注两类来源,估算数字带"约",避免被误认为精确值

#### Scenario: 上下文占比展示
- **WHEN** 会话累计的 input 侧包含用户输入与上下文(系统提示+历史+工具定义)
- **THEN** 前端展示上下文单独占比,并标注四类不含上下文

#### Scenario: 无 token 数据的会话
- **WHEN** 当前会话尚无任何 LLM 调用
- **THEN** 累计面板显示为 0,不报错
