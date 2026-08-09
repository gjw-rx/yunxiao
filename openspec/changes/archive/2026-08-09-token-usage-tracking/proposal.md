## Why

用户在使用「云效 Agent」对话时,无法了解当前会话消耗了多少 token。API 返回的 usage 数据只被部分解析(prompt/completion),`input_length` 硬编码为 0 导致 UI 恒显示 "--",且 token 数据不落库、不跨步骤累计、历史重载后丢失。用户无法据此判断会话是否接近上下文上限或估算成本。

## What Changes

- 完整解析 LLM 流式响应的 usage(`prompt_tokens` / `completion_tokens` / `total_tokens` / `reasoning_tokens`),并透传到事件与 UI。
- 修正 `input_length`:从 usage 取真实 prompt 计数,缺失时用 tokenEstimator 对请求体(system prompt + 历史 + 用户输入 + 工具定义)估算。
- 按类别记录每一轮(每次 LLM 调用)的 token 消耗,并拆分为四类:思考(reasoning)、工具调用(tool calls)、模型回复(model output)、用户输入(user input);其中思考优先取 `reasoning_tokens`,缺失时对 reasoning 增量文本估算;工具调用对 `name + arguments` 估算拆出(真实 token 口径);用户输入采用分摊法(按估算占比分摊权威 `prompt_tokens`),保证四类与总量自洽。
- 会话级累计:每步消耗汇总到当前 session,随消息持久化(MessageStore),新建会话时清零,历史加载后仍能显示。
- UI 展示会话级 token 消耗(总量 + 四类拆分 + 上下文占比),保持现有每轮回复的 token 操作栏;展示为最小可用版本,不做成本/价格换算与按模型分组统计。

## Capabilities

### New Capabilities

- `token-usage-tracking`:定义会话级 token 消耗的记录、分类(思考/工具调用/模型回复/用户输入)、持久化与展示需求。

### Modified Capabilities

<!-- 无:现有 spec 均不涉及 token 计数约束,本功能不改变它们的既有需求。 -->

## Impact

- `src/llm/streamParser.ts`、`src/llm/types.ts`:扩展 usage 解析与事件类型。
- `src/core/types.ts`、`src/core/eventBus.ts`:扩展 `TokenUsage` 字段与事件载荷。
- `src/agent/agentLoop.ts`:修正 `input_length`,在 `consumeStream` 中记账并聚合。
- `src/agent/tokenEstimator.ts`:补充系统提示词/工具定义/字符串估算入口。
- `src/memory/types.ts`、`src/memory/messageStore.ts`:消息增加可选 token 记账字段,持久化不破坏现有数据。
- `src/chatPanel.ts` 及 webview HTML:会话级累计展示。
- 不引入新依赖(继续使用现有 tokenEstimator 的字符估算,不采用第三方 tokenizer)。
