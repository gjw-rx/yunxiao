## Why

Agent Loop 在执行简单任务时反复调用工具 70+ 次仍无法完成。根因是 harness 工程缺少循环检测、干预和收敛机制：无重复调用检测（P0）、历史无限膨胀且 compaction 触发太晚（P1）、compaction 丢失关键上下文导致 LLM 重复尝试（P2）、maxSteps 默认 50 过高（P3）、系统提示词缺少防循环指导（P4）、工具结果无缓存（P5）。需要系统性地修复 Loop 的收敛行为，确保简单任务在 5-15 步内完成。

## What Changes

- **P0 重复调用检测**：在 AgentLoop 中新增 `ToolCallTracker`，检测同一 `(tool, args)` 连续重复调用。连续重复达阈值（默认 3 次）时，注入引导消息而非继续执行，迫使 LLM 改变策略或停止。
- **P1 compaction 提前触发**：将 compaction 阈值从 `contextWindow - maxOutput - buffer` 调整为更积极的触发策略（按消息条数 + token 双阈值），并在每轮工具执行后额外检查一次。
- **P2 compaction 保留关键上下文**：在 compaction 摘要 prompt 中增加"已尝试但失败的操作"和"已完成的工作"结构化字段，确保 LLM 压缩后不会丢失进度信息。
- **P3 降低 maxSteps 默认值**：将 `agent.maxSteps` 默认值从 50 降至 25，并在 step 达到 80% 时注入"接近步数上限"的预警提示。
- **P4 系统提示词增加防循环指导**：在 `DEFAULT_AGENT_PROMPT` 中增加明确的防循环规则："不要重复调用相同参数的同一工具"、"如果工具失败，尝试不同方法"、"完成任务后直接回复，不要继续调用工具"。
- **P5 工具结果缓存**：在 AgentLoop 中新增 `ToolResultCache`，对只读工具（permission=read）按 `(tool, args)` 缓存结果，同一参数的重复调用直接返回缓存结果并附注"（已缓存）"标记。

## Capabilities

### New Capabilities

- `agent-loop-convergence`: Agent Loop 收敛控制机制，包含重复调用检测、步数预警、工具结果缓存三个子能力，确保 Loop 在合理步数内收敛。

### Modified Capabilities

- `local-agent-session`: AgentLoop.run() 内部行为变更——每轮迭代新增重复检测、缓存检查、步数预警逻辑，循环终止条件从"无工具调用"扩展为"无工具调用 或 重复检测触发"。
- `memory-history-loader`: compaction 触发策略变更——从单一 token 阈值改为消息条数 + token 双阈值，且在工具执行后额外触发检查。
- `memory-message-store`: compaction 摘要模板变更——增加"已尝试操作"和"已完成工作"结构化字段，保留进度信息防止 LLM 压缩后重试。

## Impact

- **核心代码**：`src/agent/agentLoop.ts`（新增 ToolCallTracker + ToolResultCache 集成）、`src/agent/systemPrompt.ts`（新增防循环指导）、`src/agent/compaction.ts`（摘要模板 + 触发策略调整）、`src/extension.ts`（maxSteps 默认值调整）
- **新增文件**：`src/agent/toolCallTracker.ts`（重复检测）、`src/agent/toolResultCache.ts`（结果缓存）
- **测试**：需新增 toolCallTracker、toolResultCache 单元测试 + agentLoop 集成测试（验证收敛行为）
- **配置**：`agent.maxSteps` 默认值从 50 → 25，新增 `agent.repeatThreshold`（默认 3）、`agent.cacheReadTools`（默认 true）
- **依赖**：无新外部依赖
