## Context

Agent Loop 当前缺少上下文压缩机制。随着对话轮次增加，消息列表持续增长，导致：
1. LLM 上下文窗口超限（context overflow），请求失败
2. 即使未超限，早期上下文也被后续消息淹没，LLM 丢失关键信息

参考 opencode 的锚定摘要（anchored summary）策略，实现增量式上下文压缩。核心思路：将历史消息分割为 head（旧消息，摘要压缩）和 recent（最新消息，保留原文），用 LLM 生成结构化摘要替代 head，后续历史加载从 compaction 检查点开始。

## Goals / Non-Goals

**Goals:**
- 实现 token 估算器，支持按消息粒度估算 token 数
- 实现分割算法，按 token 预算将消息列表分为 head（摘要）和 recent（保留）
- 实现摘要生成，调用 LLM 生成结构化摘要（含 Objective/Details/Work State/Next Move/Relevant Files）
- 实现自动压缩触发：在 Agent Loop 每轮开始前检查 token 总量，超限时自动压缩
- 实现 overflow 恢复：捕获 LLM 的 context overflow 错误，自动触发压缩后重试

**Non-Goals:**
- 不实现精确 token 计数（使用字符数/4 近似估算）
- 不实现 Context Epoch 版本管理
- 不实现多轮压缩历史追溯（仅保留最新 compaction 检查点）
- 不修改已存在的 Message 类型定义（复用已有 compaction 消息类型）

## Decisions

### 1. Token 估算：字符数/4 近似值
- **选择**：`Math.ceil(text.length / 4)` 作为近似估算
- **理由**：无需引入 tiktoken 等依赖，足够用于触发判断。估算偏差在 2x 以内，通过 buffer 容错
- **替代方案**：使用 tiktoken 精确计数 → 引入 WASM 依赖，增加构建复杂度

### 2. 分割策略：从最新消息向前累积
- **选择**：从最新消息向前遍历，累积 token 数，达到 keepTokens 预算时分割
- **理由**：最新消息包含当前对话上下文，应优先保留原文
- **边界处理**：边界消息按 token 比例切分，确保不超出预算

### 3. 摘要模板：结构化 Markdown
- **选择**：使用固定的结构化模板，包含 Objective/Details/Work State/Next Move/Relevant Files 五段
- **理由**：结构化的摘要便于 LLM 后续理解和增量更新
- **替代方案**：自由文本摘要 → 信息密度低，后续更新困难

### 4. 增量更新：合并已有摘要
- **选择**：如果已存在 compaction 消息，将现有摘要内容作为 existingSummary 传入，使用增量更新 prompt
- **理由**：避免重复摘要丢失信息，保持摘要连贯性

### 5. 触发时机：每轮开始前自动检查
- **选择**：在 Agent Loop 每轮 `while(true)` 开始时调用 `compactIfNeeded`
- **理由**：确保每轮都在可用上下文窗口内工作，避免中间轮次超限

### 6. Overflow 恢复：捕获错误后重试
- **选择**：捕获 LLM 返回的 context overflow 错误，触发压缩后重试当前 turn
- **理由**：token 估算不精确，实际可能超限；自动恢复提供兜底

## Risks / Trade-offs

- [Token 估算偏差] → 通过 buffer（20000 tokens）容错，overflow 恢复作为兜底
- [摘要信息丢失] → 增量更新策略减少信息丢失，保留 recent 原文作为上下文
- [LLM 调用成本] → 压缩仅在必要时触发（token 超限），且摘要调用使用小模型
- [并发压缩] → 确保同一时刻只有一个压缩在进行，通过 flag 控制