## 1. 类型与解析层

- [x] 1.1 扩展 `src/llm/types.ts`:为 `UsageEvent` 增加可选 `reasoningTokens` 字段
- [x] 1.2 扩展 `src/llm/streamParser.ts`:解析 `total_tokens` 与 `reasoning_tokens`(SSEChunk.usage 增加字段并透传)
- [x] 1.3 扩展 `src/core/types.ts`:`TokenUsage` 增加可选 `reasoning_tokens`;`TokenUsageEventPayload` 增加四类拆分字段与 `source` 标记
- [x] 1.4 在 `src/core/types.ts` / `src/core/eventBus.ts` 中新增 `session_token_usage` 事件类型及其 payload(会话级 total + 四类拆分)

## 2. 估算器扩展

- [x] 2.1 在 `src/agent/tokenEstimator.ts` 增加字符串估算入口 `estimateText(text: string): number`(字符数/4)
- [x] 2.2 增加请求体估算入口 `estimateRequest(systemPrompt, messages, tools)`,用于 usage 缺失时的 `input_length` 兜底

## 3. 存储层扩展

- [x] 3.1 在 `src/memory/types.ts` 定义 `TokenUsageSnapshot`(usage + 拆分 + source)并挂到 `AssistantMessage.tokenUsage?`
- [x] 3.2 为 `UserMessage` 增加可选 `inputTokens`(估算),`InputMessage` 相应透传

## 4. AgentLoop 记账

- [x] 4.1 在 `consumeStream` 中累积 reasoning 增量文本长度与 toolCall 参数,usage 事件携带 `reasoningTokens`
- [x] 4.2 修正 `input_length`:优先 `usage.prompt_tokens`,缺失时对请求体估算
- [x] 4.3 每步结束时组装 token 账(思考/工具调用/模型回复/用户输入 + source),附加到即将 append 的 assistant 消息与用户消息
- [x] 4.4 run 结束时发射 `session_token_usage` 事件(会话级汇总:total + 四类拆分)

## 5. 前端展示

- [x] 5.1 `src/chatPanel.ts` 转发 `session_token_usage` 为前端 command
- [x] 5.2 webview HTML 增加会话级累计面板:总量、四类拆分、上下文占比,估算/真实标注区分;无数据时显示 0
- [x] 5.3 历史重载时按消息聚合恢复会话累计,旧消息无 token 字段时估算补齐展示(不回写)

## 6. 测试与验证

- [x] 6.1 单元测试:streamParser 解析 `total_tokens`/`reasoning_tokens` 及缺失时兜底
- [x] 6.2 单元测试:tokenEstimator 新增估算入口
- [x] 6.3 单元测试:consumeStream 记账与四类拆分(无工具调用/含工具调用/估算来源标记)
- [x] 6.4 单元测试:会话累计聚合(跨步骤、历史重载、新建会话清零、旧消息估算补齐)
- [x] 6.5 运行 `npm run check-types`、`npm run lint`、`npm test` 全绿
