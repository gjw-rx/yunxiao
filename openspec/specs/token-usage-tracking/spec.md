# token-usage-tracking Specification

## Purpose
TBD - created by archiving change migrate-to-vercel-ai-sdk. Update Purpose after archive.
## Requirements
### Requirement: LLM usage 完整解析与透传
AI SDK 模型运行时 SHALL 从一次 `fullStream` 的最终 usage 元数据中解析 `inputTokens`、`outputTokens`、`totalTokens` 与 `reasoningTokens`（provider 提供时），并将其规范化为现有 `token_usage` 事件。所有接受的 token 计数 SHALL 为有限、非负整数；`reasoningTokens` SHALL 不大于 `outputTokens`，`cacheReadTokens` 与 `noCacheTokens` SHALL 不大于 `inputTokens`。无效的可选细分 SHALL 被省略并记录含模型、字段和值/原因的诊断日志；无效或缺失的 reasoning SHALL 按本次流中累积的 reasoning 增量文本估算。`input_length` 字段 SHALL 反映本次请求的真实 prompt token 数：优先取经校验的 `inputTokens`，缺失时 SHALL 使用估算器对请求体（system prompt + 历史消息 + 用户输入 + 工具定义）估算，不得硬编码为 0。有效的 provider `totalTokens` SHALL 原样透传，即使它不同于 input 与 output 之和；缺失或无效的 total SHALL 以经校验的 input 与 output 之和回退。每次模型调用 SHALL 最多透传一条权威 usage 事件，避免中间 step usage 与最终 usage 重复记账。

#### Scenario: AI SDK usage 含完整字段
- **WHEN** AI SDK 最终 usage 包含 inputTokens=100、outputTokens=50、totalTokens=150、reasoningTokens=20
- **THEN** 运行时产出一条 usage 事件，`token_usage` 事件载荷中 `total_tokens=150`、`reasoning_tokens=20`、`input_length=100`

#### Scenario: provider 返回负 reasoning
- **WHEN** AI SDK 最终 usage 包含 inputTokens=11583、outputTokens=105、totalTokens=11688、reasoningTokens=-59
- **THEN** 运行时 SHALL 保留 input、output 和 total，省略 `reasoning_tokens`，记录字段校验诊断，并按 reasoning 增量文本估算该步 reasoning

#### Scenario: usage 缺少 reasoningTokens
- **WHEN** AI SDK 最终 usage 只有 inputTokens 与 outputTokens，无 reasoningTokens
- **THEN** 系统对本次流中累积的 reasoning 增量文本估算 reasoning token，并以 `source=estimated` 标记

#### Scenario: usage 缺失时按请求体估算 input_length
- **WHEN** AI SDK 响应未携带 usage 数据，但 LLM 请求体包含 system prompt、历史消息、用户输入与工具定义
- **THEN** `input_length` 等于估算器对完整请求体的估算值，且标注 `source=estimated`

#### Scenario: 中间 step usage 与最终 usage 同时存在
- **WHEN** AI SDK 流同时产生中间 step usage 与最终 total usage
- **THEN** 系统仅使用最终 total usage 生成权威 token_usage 事件和本步骤 token 账

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
存储层消息 SHALL 支持可选 token 记账字段:assistant 消息可携带每次模型调用的 `tokenUsage`（真实 usage、输入缓存细分、四类拆分和 source），用户消息可携带 `inputTokens` 作为辅助分摊值。拥有 `tokenUsage` 的 assistant 消息 SHALL 是会话累计的唯一权威记录；历史重载时 SHALL 只聚合这些快照，以得到与保存前实时累计相同的 total、四类拆分、上下文和缓存细分。用户消息的 `inputTokens` SHALL NOT 被再次累加。无 tokenUsage 的旧 assistant 消息 SHALL 按内容估算补齐展示（不回写存储），并与已有快照的同一调用避免重复计数。新建会话 SHALL 从零累计。

#### Scenario: 会话累计跨步骤
- **WHEN** 一个 run 完成 3 步 LLM 调用,每步记账分别落库
- **THEN** 会话累计等于 3 笔 assistant tokenUsage 之和,包含 total、reasoning、toolCalls、modelOutput、userInput、上下文和可用缓存细分

#### Scenario: 历史重载恢复累计
- **WHEN** 会话消息被从 workspaceState 重新加载,assistant 消息携带 tokenUsage 字段，用户消息也携带 inputTokens
- **THEN** 前端聚合结果与保存前的服务端会话累计一致，且不会因用户消息重复增加 userInput

#### Scenario: 旧消息无 token 字段
- **WHEN** 加载的历史消息没有 tokenUsage/inputTokens 字段
- **THEN** 系统按消息内容估算补齐展示,标记 `source=estimated`,且不写回存储

#### Scenario: 新建会话清零
- **WHEN** 用户点击"新建会话"并开始新对话
- **THEN** 会话累计从零开始,不包含旧会话的 token 数据

### Requirement: 会话级 token 消耗展示
UI SHALL 展示当前会话的累计 token 消耗，包含 provider total、四类拆分(思考/工具调用/模型回复/用户输入)、上下文输入估算及可用的缓存输入细分。缓存读取/写入 SHALL 被标识为输入侧明细，SHALL NOT 再次加入累计 total；上下文 SHALL 被表述为 prompt 的归属估算，SHALL NOT 被表述为模型上下文窗口占比。每次调用的消息操作栏 SHALL 展示明确的本次 token 消耗及 input/output/cache 明细，SHALL NOT 用 `total_tokens / input_length` 作为上下文百分比或显示基于该比值的进度条。估算数字 SHALL 与真实数字以不同样式或标注(如"约")区分。会话级汇总 SHALL 在 run 结束时通过 `session_token_usage` 事件推送,历史重载时由前端按 assistant 快照聚合,并覆盖会话页。成本/价格换算与按模型分组统计 SHALL NOT 在本期实现。

#### Scenario: run 结束推送汇总
- **WHEN** AgentLoop 的 run 正常完成
- **THEN** 系统发射 `session_token_usage` 事件,payload 包含会话级 total、四类拆分、上下文和可用缓存细分,前端更新累计条

#### Scenario: 大缓存命中的调用展示
- **WHEN** 一次调用报告 prompt=11583、output=105、total=11688 和 cacheRead=11392
- **THEN** UI 将 total 显示为 11688，并将缓存读取显示为输入侧明细，不把它加到 total，也不显示约 100% 的伪上下文占比

#### Scenario: 估算与真实区分展示
- **WHEN** 会话累计中同时存在 source=usage 与 source=estimated 的数字
- **THEN** 前端分别标注两类来源,估算数字带"约",避免被误认为精确值

#### Scenario: 上下文输入展示
- **WHEN** 会话累计的 input 侧包含用户输入与上下文(系统提示+历史+工具定义)
- **THEN** 前端将上下文作为单独的 prompt 输入估算展示，并标注四类不含上下文，不展示上下文窗口百分比

#### Scenario: 无 token 数据的会话
- **WHEN** 当前会话尚无任何 LLM 调用
- **THEN** 累计面板显示为 0,不报错

### Requirement: AI SDK cache token metadata is retained when available
When AI SDK final usage includes valid `noCacheTokens`, cache read, or cache write token details, the token usage snapshot SHALL retain each supplied value with provider-usage source metadata and the session aggregate SHALL sum it as a separate input-side detail. Providers that omit cache details SHALL remain compatible and SHALL NOT produce fabricated cache values; invalid cache values SHALL be omitted with a diagnostic log. Cache details SHALL NOT be added to `total_tokens` because they describe the composition of an input-side request rather than an additional model call.

#### Scenario: Provider reports cache token details
- **WHEN** AI SDK final usage includes inputTokens=100, noCacheTokens=60, cache read tokens=40, or cache write tokens=5
- **THEN** the persisted token usage snapshot retains the supplied valid fields and the session payload aggregates them separately from total_tokens

#### Scenario: Provider omits cache token details
- **WHEN** AI SDK final usage does not include cache read, cache write, or no-cache token details
- **THEN** token tracking leaves those fields absent and preserves the existing total, reasoning, tool-call, model-output, user-input, and context accounting

#### Scenario: Provider reports impossible cache read detail
- **WHEN** AI SDK final usage contains inputTokens=100 and cacheReadTokens=101
- **THEN** token tracking omits cacheReadTokens, records a diagnostic log, and preserves valid top-level usage fields

