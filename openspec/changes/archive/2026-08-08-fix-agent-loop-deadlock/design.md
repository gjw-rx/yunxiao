## Context

当前 AgentLoop（`src/agent/agentLoop.ts`）是一个单层 `while(true)` 循环，驱动 LLM 推理 → 工具调用 → 续轮。设计参考 opencode 的双层循环但简化掉了 steer/queue 层，导致没有任何"刹车"机制。实际运行中，LLM 可能在同一参数上循环调用工具（如反复 read_file 同一路径），Loop 盲目执行直到 `maxSteps=50`，产生 70+ 次工具调用。

当前各模块职责：

- `AgentLoop`：主循环，流式调用 LLM，执行工具，续轮
- `compaction.ts`：token 阈值触发压缩，生成锚定摘要
- `systemPrompt.ts`：每轮重建系统提示词
- `historyLoader.ts`：从 MessageStore 加载历史，处理 compaction 检查点
- `messageStore.ts`：内存 + workspaceState 持久化，1000 条上限
- `baseTool.ts`：governResult 做 10K 字符截断

约束：

- 不引入 SQLite 或外部依赖
- 保持 TypeScript 纯实现
- 不改变 Provider 接口
- 不改变工具注册/路由架构

## Goals / Non-Goals

**Goals:**

- 简单任务在 5-15 步内收敛完成
- 连续重复调用同一工具+参数时，3 次内检测并干预
- 只读工具重复调用直接返回缓存，不产生 I/O
- compaction 不丢失"已尝试操作"关键信息
- 系统提示词明确指导 LLM 避免循环

**Non-Goals:**

- 不实现 opencode 的完整 steer/queue 双层循环（过度工程化）
- 不引入 SQLite 持久化（保持 workspaceState）
- 不改变工具并发模型（Phase 3 串行执行不变）
- 不实现完整的 Context Epoch 版本管理
- 不改变 Provider/StreamParser 层

## Decisions

### D1: ToolCallTracker — 重复检测器

**选择**：新建 `src/agent/toolCallTracker.ts`，在 AgentLoop 内部跟踪连续相同 `(tool, JSON.stringify(args))` 调用次数。达到阈值（默认 3）时不执行工具，改为向 messages 追加一条 user 消息：`"You are repeatedly calling {tool} with the same arguments. This suggests you may be stuck. Please try a different approach or summarize what you have accomplished."`，然后 continue 续轮。

**替代方案**：直接 break 循环。否决——太粗暴，LLM 可能只是需要换思路。注入引导消息让 LLM 有机会自我纠正。

**设计细节**：

- 追踪窗口仅限"连续"调用——如果中间有不同工具调用，计数器重置
- key = `tool + JSON.stringify(args)` 的稳定序列化
- 阈值可配置 `agent.repeatThreshold`（默认 3）
- 触发后清零计数器（避免下一轮立即再次触发）

### D2: ToolResultCache — 只读工具结果缓存

**选择**：新建 `src/agent/toolResultCache.ts`，对 `permission === 'read'` 的工具按 `(tool, args_hash)` 缓存结果。缓存命中时直接返回缓存结果，在 content 前加 `"[cached] "` 前缀，不执行工具。

**设计细节**：

- 缓存 key = `tool + JSON.stringify(args)`（稳定排序）
- 仅缓存 `status === 'success'` 的结果
- 缓存生命周期 = 单次 `AgentLoop.run()` 调用（不跨会话）
- 缓存大小无上限（单次 run 内不会膨胀到不可控）
- 可配置 `agent.cacheReadTools`（默认 true）关闭

**替代方案**：全局缓存跨会话。否决——文件可能被修改，跨会话缓存会返回过期内容。

### D3: compaction 提前触发 — 双阈值 + 工具后检查

**选择**：修改 compaction 触发策略：

1. 现有 token 阈值保留但降低 buffer（从 20000 → 15000）
2. 新增消息条数阈值：当消息数 > 40 条时触发（简单任务不会积累到 40 条）
3. 在每轮工具执行完毕后额外触发一次 `compactIfNeeded` 检查（当前仅每轮开始时检查）

**替代方案**：按固定间隔触发（每 10 步）。否决——步数与 token 无线性关系，按条数+token 更精确。

### D4: compaction 摘要模板增强

**选择**：在 `compaction.ts` 的摘要 prompt 模板中增加两个结构化字段：

```
## Failed Attempts
- [Tool name + args + error reason, for each failed attempt]

## Completed Work
- [Successfully completed tool calls and their outcomes]
```

这确保压缩后的摘要明确告诉 LLM "哪些方法已经试过但失败了"，避免压缩后重试。

### D5: maxSteps 降低 + 步数预警

**选择**：

- `agent.maxSteps` 默认值从 50 → 25
- 在 step 达到 `maxSteps * 0.8`（即第 20 步）时，向 messages 追加预警：`"You are approaching the maximum step limit ({maxSteps} steps). You have used {step} steps. Please wrap up your work."`
- 保持达到 maxSteps 后 `toolChoice: 'none'` + MAX_STEPS_PROMPT 的现有行为

### D6: 系统提示词防循环指导

**选择**：在 `DEFAULT_AGENT_PROMPT` 中增加：

```
# Loop prevention
- Do not call the same tool with the same arguments more than twice. If a tool call fails, try a different approach instead of repeating.
- If you find yourself stuck in a loop, step back and reconsider your approach.
- When you have completed the task, provide your final answer directly without calling more tools.
```

### D7: AgentLoop 集成点

在 `agentLoop.ts` 的 `run()` 方法中，工具执行前新增：

```
1. 检查 ToolResultCache（read 工具）→ 命中则跳过执行
2. 检查 ToolCallTracker → 连续重复达阈值 → 注入引导消息 + continue
3. 工具执行后 → 结果存入 ToolResultCache（read 工具）
4. 工具执行后 → 触发 compactIfNeeded 额外检查
5. step 达到预警线 → 注入预警消息
```

## Risks / Trade-offs

- **[ToolResultCache 返回过期内容]** → 仅缓存 read 工具 + 单次 run 生命周期 + `[cached]` 标记让 LLM 知悉。文件在单次 run 内被修改的概率低。
- **[重复检测误判]** → 仅对完全相同参数的连续调用触发。不同参数（如不同 offset 的 read_file）不会误判。
- **[compaction 消息条数阈值过低导致频繁压缩]** → 设为 40 条，简单任务不会触及。可通过配置 `compaction.messageThreshold` 调整。
- **[maxSteps=25 对复杂任务不够]** → 可通过配置 `agent.maxSteps` 调整。25 步 × 1.5 工具/步 ≈ 37 次工具调用，对绝大多数任务足够。
- **[引导消息打断 LLM 思路]** → 这是预期行为——如果 LLM 在重复，打断它正是目的。引导消息是温和的提示而非强制终止。
