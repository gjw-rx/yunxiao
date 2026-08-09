## Context

「云效 Agent」的 AgentLoop 每步调用 OpenAI 兼容的 `/chat/completions` 流式接口,响应中携带 usage 数据。当前实现存在以下缺口:

- `streamParser.ts` 只解析 `prompt_tokens` / `completion_tokens`,丢弃 `total_tokens` / `reasoning_tokens`。
- `agentLoop.ts` 的 `consumeStream` 收到 usage 事件时 `input_length` 硬编码为 0,导致 UI 恒显示 "--"。
- 每条 assistant 消息在存储层无 token 字段,token 数据不落库;历史重载后无法恢复会话累计。
- 思考(reasoning)、工具调用(tool calls)、模型回复(model output)、用户输入(user input)四类无法从 API usage 直接拆分,需要估算补齐。

现有基础:`token_usage` 事件通道与前端每轮 token 操作栏已存在;`tokenEstimator.ts` 提供字符数/4 的估算;`MessageStore` 将整个会话消息数组整体持久化到 `workspaceState`。

**设计依据(opencode 调研)**:参考了 opencode 的 token 计算实现(`docs/opencode源码/`):usage 由 LLM 调用层聚合后经 `getUsage()` 统一换算(拆出 reasoning、clamp ≥ 0),tokens/cost 挂在 assistant 消息 metadata 上、统计时遍历求和,成本按模型价格表 × 每百万 token 换算。本设计沿用其「消息挂账 + 遍历求和」与「reasoning 从 output 拆出」的核心思路;工具调用 token 与用户输入 token 为超出 opencode 的额外拆分维度(后者用分摊法补齐)。

## Goals / Non-Goals

**Goals:**

- 完整解析并透传 usage(`prompt_tokens` / `completion_tokens` / `total_tokens` / `reasoning_tokens`)。
- 每步 LLM 调用记录一笔 token 账:真实 input/output 用量 + 四类拆分(思考/工具调用/模型回复/用户输入)。
- 账随消息持久化,新建会话清零,历史重载后会话累计仍可恢复展示。
- UI 展示会话级 token 消耗(总量、四类拆分、上下文占比),并修复现有 "--" 问题;展示为最小可用版本,沿用现有前端,只新增会话级累计条。

**Non-Goals:**

- 不引入第三方 tokenizer(继续使用字符数/4 估算,标注"估算"来源)。
- 不做成本/价格换算与按模型分组统计(模型单价配置不在本期;多模型会话统一累计展示,design 留扩展位)。
- 不做 opencode 风格的独立统计视图(/stats)、按模型拆分 UI、工具调用次数视图;本期仅会话级累计条。
- 不改变 MessageStore 存储格式(新增字段可选,旧数据可读)。
- 不记录工具结果输出的 token(工具结果计入 prompt 侧,不单独拆分)。

## Decisions

### D1: usage 优先,估算兜底;工具调用用真实 token 估算拆出(A 方案)

真实 usage 是唯一权威数字;四类拆分缺失时用 `tokenEstimator`(字符数/4)估算,并在 UI 标注来源(真实/估算)。

- `prompt_tokens` / `completion_tokens` / `total_tokens`:直接取 usage。
- `reasoning_tokens`:优先取 usage(若 provider 返回);缺失时对本次流中累积的 reasoning 增量文本估算。
- 工具调用 token(A 方案,按真实 token 估算拆出):对每个 toolCall 的 `name + arguments` 字符串估算,作为独立维度;不采用 opencode「只统计工具调用次数、token 计入 output」的口径。
- 模型回复 token:优先 `completion_tokens - reasoning_tokens - 工具调用估算`(clamp ≥ 0);无法计算时对 `textContent` 估算。
- 用户输入 token:采用**分摊法**(见 D1.1),不单独估算。

**Alternatives considered:**

- 只展示 total,不拆分 → 不满足用户"四类"需求,否决。
- 仅依赖 usage 且缺失时显示 "--" → 维持现状问题,否决。
- 工具调用走 opencode 口径(只计次数、token 算 output)→ 用户明确要求工具调用的实际 token,否决。

### D1.1: 用户输入 token 用分摊法(最稳方式)

`prompt_tokens` 是整段请求(系统提示 + 历史 + 用户输入 + 工具定义)的混合权威值,无法精确分离出用户输入。分摊法保证「四类之和与总量一致」:

```
用户输入 tokens = input_total × (估算(用户消息 + attachments) / 估算(完整请求体))
```

- `input_total` 为 provider 报的权威值;比例由估算器对「用户消息」与「完整请求体」分别估算得出。
- 加总后四类拆分与总量自洽:`总量 = input_total + completion_total`(权威);`四类 = 思考 + 工具调用 + 模型回复 + 用户输入`;`上下文 = input_total − 用户输入`(系统提示 + 历史 + 工具定义,自然成为第五类)。
- 展示口径明确标注:**四类不含上下文**,上下文单独占比展示,避免用户困惑"加起来对不上"。

**Alternatives considered:**

- 对用户消息单独估算、与 input_total 无关 → 四类之和与总量不一致,误导用户,否决。
- 不做用户输入拆分 → 不满足需求四类中的"用户输入",否决。

### D2: 每步记账,挂载到消息,前端聚合

每次 LLM 调用结束时,把该步的 token 账作为可选字段附加到即将 append 的 assistant 消息上(`tokenUsage`);用户输入估算附加到用户消息(`inputTokens`)。会话累计由前端/加载端对消息数组求和,无需独立 ledger 存储。

- 每步 token 账(真实 usage + 四类拆分)挂到 assistant 消息;用户输入分摊值挂到用户消息(`inputTokens`),分摊比例来源标记为 `estimated`。
- 历史重载时,无 `tokenUsage` 的旧消息按内容估算补齐(仅展示,不回写)。

**Rationale:** `MessageStore` 已整体持久化消息数组,附加字段零额外存储成本、无迁移;会话累计天然与消息生命周期一致(新建会话即清空)。

**Alternatives considered:**

- 独立的会话级 ledger(新 workspaceState key)→ 需额外读写、易与消息不同步,否决。

### D3: 扩展事件与类型,保持向后兼容

- `UsageEvent` 增加可选 `reasoningTokens`。
- `TokenUsage` 增加可选 `reasoning_tokens`;`TokenUsageEventPayload` 增加可选拆分字段与 `source` 标记。
- `input_length` 从 0 改为:优先 `usage.prompt_tokens`,缺失时对请求体(system prompt + history + user + tools 定义)估算。
- 新增事件 `session_token_usage`(run 结束时发射,payload 为会话级汇总),前端展示累计面板;`token_usage` 事件保持每步发射,兼容现有 UI。

**Alternatives considered:**

- 只在 `token_usage` 里加累计 → 每步重发全量累计,语义混乱,否决。
- 新增独立事件通道 → 前端需另接消息处理,收益低,否决。

### D4: 估算来源标注与展示口径

每条 token 数字带 `source: 'usage' | 'estimated'`,UI 用不同样式/标注区分,避免把估算当精确值误导用户。展示为最小可用版本:沿用现有前端框架,新增会话级累计条(总量 + 四类 + 上下文占比),估算数字标注"约"。

**展示口径(与 D1.1 对齐):**

- 总量 = 各步 `input_total + completion_total` 之和(权威)。
- 四类 = 思考 + 工具调用 + 模型回复 + 用户输入(后三者可为估算)。
- 上下文 = input_total − 用户输入(不属四类,单独展示占比)。

## Risks / Trade-offs

- [不同 provider 的 usage 字段不一致(reasoning_tokens/total_tokens 可能缺失)] → 缺失字段一律走估算兜底,UI 标注"估算"。
- [估算(字符/4)与真实 token 有偏差,尤其中文场景] → 所有估算数字明确标注来源与"约";真实 usage 存在时以其为准;四类拆分与总量自洽(分摊法)。
- [工具调用 arguments 可能很长(JSON),估算偏差放大] → 工具调用数字标注"约";总量不受影响(工具 token 只影响 output 内的拆分比例)。
- [旧会话消息无 tokenUsage 字段] → 历史重载时按内容估算补齐展示,不回写存储,避免污染旧数据。
- [每步估算增加少量 CPU 开销] → 估算仅在 usage 缺失或拆分需要时执行,单次 O(n) 文本扫描,量级可忽略。
- [前端每轮 token 操作栏依赖 `input_length>0`] → 修复 input_length 后旧逻辑自动恢复,无需改动现有渲染路径。

## Migration Plan

1. 后端(类型 + 解析 + 记账)与前端(汇总面板)可在同一发布内完成,无数据库/配置迁移。
2. 旧会话数据:消息无 `tokenUsage` 时按内容估算展示,无需数据迁移脚本。
3. 回滚:字段均为可选,回退旧版本仅损失展示信息,不影响消息读写。

## Open Questions

- 本期不做:成本/价格换算、按模型分组统计、工具调用次数视图、复制为文本。均可在 `TokenUsageSnapshot` 预留字段后扩展。
