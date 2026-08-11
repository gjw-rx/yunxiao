## 1. Usage 归一化与契约

- [x] 1.1 扩展 `src/llm/types.ts`、`src/memory/types.ts` 与 `src/core/types.ts` 的可选输入缓存细分契约，保持旧快照反序列化兼容。
- [x] 1.2 在 `src/llm/aiSdkStreamAdapter.ts` 规范化 AI SDK usage：仅接受有限非负整数，校验 reasoning 与 input/output 的边界，保留有效 total 并为缺失/无效 total 建立回退。
- [x] 1.3 透传有效的 `noCacheTokens`、cache read 和 cache write 明细；对被拒绝的细分通过 `logger` 输出不含提示词的中文诊断日志。
- [x] 1.4 为 usage 归一化补充单元测试：负 reasoning、超过输出的 reasoning、超过输入的缓存读取、非有限数、合法 0 和 provider total 不等于 input+output。

## 2. Agent 记账与聚合

- [x] 2.1 更新 `src/agent/agentLoop.ts` 的流消费、快照构建和 token_usage 事件，使有效缓存/非缓存输入细分随调用落账，异常 reasoning 使用现有 reasoning delta 估算。
- [x] 2.2 更新会话累计 payload，在不改变 `total_tokens` 定义的前提下分别汇总缓存输入细分；确认缓存字段不会被重复加入 total。
- [x] 2.3 为 AgentLoop 补充回归测试：用户日志中的 `11583/105/11688/-59/11392` 场景、跨步骤缓存汇总、total 不重计和异常数据的日志/持久化行为。

## 3. Webview 展示与历史一致性

- [x] 3.1 更新 `src/chatPanel.ts` 的单次调用格式化：显示本次 total 与 input/output/cache 明细，移除 `total_tokens / input_length` 的伪上下文百分比、进度条及相关文案。
- [x] 3.2 更新会话累计条：明确上下文是输入归属估算，展示可用缓存累计，并为缺失/估算数据提供不误导的标识。
- [x] 3.3 更新历史恢复聚合，只以 assistant `tokenUsage` 快照作为权威来源，防止 user `inputTokens` 与快照 `user_input` 双重累计；保留无快照旧消息的仅展示估算兜底。
- [x] 3.4 为 ChatPanel 增加格式化与历史聚合测试，验证大缓存命中不显示 100% 百分比，且实时 payload 与历史重载的汇总一致。

## 4. 验证

- [x] 4.1 执行相关 LLM、AgentLoop 与 ChatPanel 测试，并修复本变更引入的失败。
- [x] 4.2 执行 `npm run compile`，确认 TypeScript strict、lint 和 esbuild 均通过。
