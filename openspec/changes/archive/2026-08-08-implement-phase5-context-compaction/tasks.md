## 1. Token 估算器

- [x] 1.1 创建 `src/agent/tokenEstimator.ts`，实现 `estimateMessage(msg: Message): number` 函数，使用 `Math.ceil(text.length / 4)` 估算单条消息 token 数
- [x] 1.2 实现 `estimateMessages(messages: Message[]): number` 函数，返回消息数组的 token 总数

## 2. 压缩分割算法

- [x] 2.1 创建 `src/agent/compaction.ts`，实现 `selectMessages(messages: Message[], keepTokens: number): { head: Message[]; recent: Message[] }` 函数
- [x] 2.2 实现从最新消息向前累积 token 的分割逻辑，处理边界消息按 token 比例切分

## 3. 摘要生成

- [x] 3.1 在 `compaction.ts` 中实现 `generateSummary(headMessages: Message[], existingSummary: string | null, provider: LLMProvider, model: string): Promise<string>` 函数
- [x] 3.2 构建摘要 prompt 模板（含 Objective / Important Details / Work State / Next Move / Relevant Files 五段），支持首次生成和增量更新两种模式

## 4. 压缩触发与 Agent Loop 集成

- [x] 4.1 在 `compaction.ts` 中实现 `compactIfNeeded(sessionId: string, messages: Message[], provider: LLMProvider, model: string, config: CompactionConfig, messageStore: MessageStore, eventBus: EventBus): Promise<boolean>` 函数，实现 token 估算 -> 阈值判断 -> 分割 -> 摘要生成 -> 存储 CompactionMessage 的完整流程
- [x] 4.2 定义 `CompactionConfig` 接口（enabled / keepTokens / buffer / contextWindow），在 `agentLoop.ts` 中集成 `compactIfNeeded` 调用
- [x] 4.3 在 AgentLoop 中捕获 LLM 的 context overflow 错误，实现 overflow 恢复逻辑（触发压缩后重试当前 turn）

## 5. 测试

- [x] 5.1 创建 `src/test/agent/compaction.test.ts`，编写 Token 估算器单元测试
- [x] 5.2 编写分割算法单元测试（预算内/超预算/边界切分）
- [x] 5.3 编写摘要生成单元测试（首次生成/增量更新 prompt 构建）
- [x] 5.4 编写压缩触发集成测试（低于阈值不触发/超出阈值自动触发/压缩后历史加载）
- [x] 5.5 编写 overflow 恢复集成测试