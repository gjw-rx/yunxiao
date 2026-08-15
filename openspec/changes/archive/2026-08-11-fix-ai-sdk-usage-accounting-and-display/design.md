## Context

AI SDK 的 `LanguageModelUsage` 把 `inputTokens` 定义为完整 prompt token，总 token 可以与输入、输出之和不同；缓存读取是输入侧细分，而不是独立的一次额外调用。当前适配器直接将可选细分透传，因而 DeepSeek 返回 `reasoningTokens=-59` 时会落入日志、事件和消息快照。账本虽然保存了缓存读取/写入，却不汇总、不展示。

当前单条消息 UI 用 `total_tokens / input_length` 计算“上下文占比”，但 `input_length` 被赋为相同调用的 prompt token，而非模型可用上下文窗口。因此示例中的 `11,496 / 11,487` 会稳定地接近 100%，没有诊断价值。历史恢复还同时累计 user 消息的 `inputTokens` 与 assistant 快照的 `user_input`，与实时服务器端汇总不一致。

约束：保持既有 OpenAI-compatible 运行时和 AI SDK 请求协议不变；不猜测各模型缓存价格，也不新增成本统计。既有 workspaceState 中的快照必须仍可读取。

## Goals / Non-Goals

**Goals:**

- 对 provider usage 建立边界校验和可定位日志，防止负数、非有限数或不可能的细分值污染账本。
- 保留 prompt、输出、总量与缓存/非缓存输入之间的原始语义，并在会话范围内无重复地汇总。
- 让每次调用与会话累计展示表达真实含义；实时显示与加载历史后显示相同。
- 用回归测试固定用户日志中负 reasoning 和大缓存命中的行为。

**Non-Goals:**

- 不估算或展示人民币/美元成本，不将 token 与计费金额等同。
- 不显示“上下文窗口使用率”，除非未来获得经过验证的模型上下文上限及其语义。
- 不修正上游 provider 返回的 usage；本项目只隔离其异常数据并保留可诊断信息。
- 不迁移或回写已有会话快照。

## Decisions

### 1. 以经校验的 AI SDK totalUsage 为单次调用唯一输入

在 `aiSdkStreamAdapter` 增加小型、纯函数的 usage 规范化边界：必填计数和所有可选细分均须是有限且非负的整数；`reasoningTokens` 还须不超过 output，`cacheReadTokens` 和 `noCacheTokens` 须不超过 input。无效的可选细分一律省略并记录结构化中文诊断日志；缺失/无效的 reasoning 由既有 reasoning delta 估算。有效的 provider `totalTokens` 原样保留（AI SDK 明确允许它不同于 input+output）；缺失或无效时才以经校验的 input+output 回退。

备选方案是 `Math.max(0, value)`。不采用，因为它把上游负数伪装成真实的 0，无法区分“模型没有思考”与“返回损坏”。另一方案是因为一个细分异常而丢弃整个 usage；不采用，因为示例中的 prompt/output/total 仍是有效的权威数据。

### 2. 缓存字段只作为输入侧细分，绝不加进总消耗

扩展归一化事件和持久化快照以保留 AI SDK 的 `noCacheTokens`、`cacheReadTokens` 和 `cacheWriteTokens`（仅 provider 提供且通过校验时）。prompt/total 继续是 provider 的调用总量；会话累计分别求和这些字段，但不会将它们再次加到 `total_tokens`。界面将缓存读取/写入明确显示为输入侧明细，并标记缺失字段为“未提供”。

备选方案是从 `input - cacheRead` 推导非缓存输入。不采用，因为 AI SDK 已提供 `noCacheTokens`，且 cache write 的供应商语义与输入总量并非所有后端都能由减法正确推导。

### 3. 删除伪上下文百分比，改为绝对的调用账与会话账

每个 assistant 消息显示本次调用的总 token，tooltip 展示 prompt、输出、reasoning（可用时）及缓存输入细分。移除由 `total / prompt` 产生的进度条和“上下文占比”文案。会话栏继续展示累计总量与拆分，其中 `context` 仅说明该次 prompt 中估算归属给系统提示、历史和工具定义的 token；它不是上下文窗口百分比。缓存累计作为独立输入明细展示，不能和 total 相加。

备选方案是用 `yunxiaoAgent.model.maxTokens` 作为分母。该配置是最大输出 token 而非上下文窗口，语义同样错误。

### 4. 快照是实时与历史的唯一权威聚合源

拥有 `tokenUsage` 的 assistant 消息是每次模型调用的账本记录。服务端的 session event 与 Webview 的历史恢复都只累加这些快照的 total、拆分和缓存字段；不再额外累加 user 消息的 `inputTokens`，因为它只是某次快照中 `user_input` 的辅助分摊记录。没有快照的旧历史允许以显式估算方式显示，但不得与已有快照的同一字段混合重复计数。

备选方案是让用户消息成为输入侧唯一事实来源。不采用：一个用户消息可触发多步模型调用，每步的 prompt 和分摊不同，单个可覆盖字段无法表达全部调用。

### 5. 保持兼容并让异常可观测

新增字段都为可选，旧 workspaceState 无需迁移。日志将包含模型、调用的 input/output/total、已接受缓存细分以及被忽略字段和原因，但不记录提示词或工具参数。测试覆盖归一化边界、快照/事件传递、汇总不重计和 Webview 格式化，实施后执行 `npm run compile` 与相关测试。

## Risks / Trade-offs

- [Provider 的 total 定义与 input+output 不一致] → 保留有效的 provider total，并在 UI 中不把细分相加宣称为 total。
- [少数 provider 将合法 0 或缺失混用] → 0 视为有效数值，只有 `undefined` 表示未提供；UI 明确区分。
- [旧会话没有足够信息重建一次请求的完整账本] → 仅显示带“约”的前端估算，不写回、也不伪装为 usage。
- [Webview 内嵌脚本难以与服务端复用函数] → 以相同的快照契约和场景测试保证汇总一致，避免为了复用而引入额外构建架构。

## Migration Plan

1. 先为异常 usage、缓存汇总与历史恢复添加失败测试。
2. 增加可选快照/事件字段和归一化校验，保持旧字段与序列化兼容。
3. 更新 AgentLoop 聚合和 Webview 展示；用旧快照、无快照历史及新快照分别验证。
4. 执行类型检查、lint 和测试；若出现展示问题，可回退 UI/聚合改动，旧快照仍可被当前版本读取。

## Open Questions

- 无。修复按 provider 原始 token 计数展示，不对不同模型的缓存定价作推断。
