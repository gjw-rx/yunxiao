## Context

Phase 1 实现了 LLM 连接层（`LLMProvider` 接口 + OpenAI 兼容 Provider + SSE 流式解析），Phase 2 实现了记忆管理（`MessageStore` + `loadHistoryForLLM`）。现有基础设施包含完善的工具体系（`ToolRouter`/`ToolRegistry`/`BaseTool`）、安全机制（`ApprovalGateway`/`SecurityAudit`）和事件总线（`EventBus`）。

当前缺失的是将这些组件串联起来的 Agent Loop--驱动 LLM 推理与工具调用多轮交互的核心循环。参考 opencode 的双层循环设计，但按重构方案简化为单层 while + 工具续轮。

**关键约束**：
- LLM 层的 `LLMToolCall`（id/name/arguments）与 core 层的 `ToolCall`（call_id/tool/args/site）字段名不同，需适配
- `ToolSchema` 含 permissions/site/canParallel 等 LLM 不需要的字段，需提取为 `ToolDefinition`
- `ToolContext` 需要由 AgentLoop 构建，注入 workspaceRoots 等运行时信息
- 流式响应中 tool_calls 增量片段已由 streamParser 合并，AgentLoop 收到的是完整 toolCall 事件

## Goals / Non-Goals

**Goals:**
- 实现 AgentLoop 主循环：用户消息 -> LLM 响应 -> 工具调用 -> 续轮 -> 最终回复
- 实现流式事件处理：消费 LLMEvent 流，转发为 EventBus 事件
- 实现工具执行集成：toolCall 经 ToolRouter 执行，结果回传 LLM
- 实现中断处理：AbortController 中止流 + 标记工具 cancelled
- 实现 Max Steps 限制：达到上限时禁用工具 + 追加总结提示

**Non-Goals:**
- 不实现上下文压缩（Phase 5）
- 不实现系统提示词构建（Phase 4，本阶段用临时占位）
- 不实现 Skill 系统（Phase 4）
- 不实现 Overflow 恢复（Phase 5）
- 不修改现有 core/tools 代码
- 不做前端适配（Phase 6）

## Decisions

### 1. AgentLoop 作为独立类，依赖注入

**选择**：`AgentLoop` 类通过构造函数接收所有依赖（provider、messageStore、toolRouter、toolRegistry、eventBus、config）。

**理由**：依赖注入便于测试和替换组件。相比全局单例，测试时可传入 mock 依赖。

**替代方案**：全局单例 -> 难以测试，多 session 场景下状态混乱。

### 2. 类型适配层独立为 toolAdapter.ts

**选择**：新建 `src/agent/toolAdapter.ts`，包含 `toolSchemaToDefinition`、`llmToolCallToCoreToolCall`、`toolResultToToolMessageContent` 等纯函数。

**理由**：LLM 层和 core 层的类型字段名差异较大（id vs call_id, name vs tool, arguments vs args），独立适配层职责清晰，避免 AgentLoop 中充斥转换代码。

**替代方案**：内联在 AgentLoop 中 -> 代码臃肿，转换逻辑分散。

### 3. 系统提示词使用临时占位

**选择**：AgentLoop 中定义一个 `buildTempSystemPrompt()` 函数，返回最小化的系统提示词。Phase 4 再替换为完整的 `buildSystemPrompt`。

**理由**：Phase 3 聚焦循环逻辑，系统提示词构建是 Phase 4 的任务。但 LLM 调用需要 system 消息，所以用临时占位保持可运行。

### 4. 中断处理使用 AbortController

**选择**：AgentLoop 内部维护 `AbortController`，`cancel()` 方法调用 `abort()`。将 `abortSignal` 注入 `ToolContext` 传给工具执行。

**理由**：`AbortController` 是 Web 标准，`fetch` 原生支持中断，`ToolContext` 已有 `abortSignal` 字段。

**替代方案**：自定义中断标志位 -> 无法中断正在进行的 fetch 请求。

### 5. Max Steps 达到后的处理策略

**选择**：达到 maxSteps 时，设置 `toolChoice: "none"`，追加 MAX_STEPS_PROMPT 到消息末尾，让 LLM 输出最终总结后 break。

**理由**：直接 break 会丢失 LLM 的总结。禁用工具 + 提示总结能让用户得到完整的工作汇报。

### 6. 工具并行执行策略

**选择**：当前阶段串行执行所有 toolCalls。利用 `ToolRouter.canRunInParallel` 判断能力已存在，但并行执行增加复杂度（结果顺序、错误处理），留到后续优化。

**理由**：Phase 3 聚焦核心循环正确性。串行执行逻辑简单，易于调试。opencode 的并行执行也非核心路径。

### 7. ToolContext 构建

**选择**：AgentLoop 构造时接收 `ToolContext` 的部分字段（workspaceRoots、maxFileSize 等），在 `run()` 时补充 sessionId 和 abortSignal 后传给 ToolRouter。

**理由**：workspaceRoots 等是会话级不变的，sessionId/abortSignal 是每次 run 特有的。

## Risks / Trade-offs

- **[流式中断不完整]** -> 中断时 LLM 可能已部分输出，assistant 消息的 content 可能不完整。缓解：标记为 interrupted，前端可显示中断提示。
- **[工具执行错误处理]** -> 工具可能超时、拒绝审批、抛异常。缓解：捕获所有错误，转为 `{ status: 'error', error: message }` 的 ToolResult，作为 tool 消息回传 LLM，让 LLM 决定下一步。
- **[Max Steps 边界]** -> maxSteps 刚好等于工具调用次数时，可能在 LLM 还没总结前就触发限制。缓解：在工具续轮前检查 step 计数，留出最后一轮给 LLM 总结。
- **[消息顺序]** -> 多个 toolCall 串行执行时，assistant 消息只追加一次（含所有 toolCalls），tool 消息按执行顺序逐个追加。确保 tool 消息紧跟 assistant 消息。
