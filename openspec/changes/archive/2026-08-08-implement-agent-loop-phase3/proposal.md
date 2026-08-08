## Why

Phase 1（模型连接层）和 Phase 2（记忆管理）已完成，具备了 LLM 流式调用和消息存储能力。但目前缺少核心的 Agent Loop 来串联这两者——没有本地循环驱动"用户消息 -> LLM 响应 -> 工具调用 -> 续轮 -> 最终回复"的完整流程。这是从云端 Agent 架构转向本地全栈 Agent 的关键缺失环节，必须在此阶段补齐。

## What Changes

- 新建 `src/agent/agentLoop.ts`：实现 `AgentLoop` 类，包含主循环入口 `run(sessionId, userText)`，集成 LLMProvider + MessageStore + ToolRouter + EventBus
- 新建 `src/agent/toolAdapter.ts`：实现类型转换层，将 LLM 的 `LLMToolCall`（id/name/arguments）与 core 的 `ToolCall`（call_id/tool/args/site）互转，将 `ToolSchema` 转换为 `ToolDefinition`
- 实现流式事件处理：消费 `LLMEvent` 流，textDelta 转发为 EventBus content 事件，toolCall 收集为 pendingToolCalls，finish 判断是否续轮
- 实现工具执行集成：将收集的 toolCalls 经 ToolRouter 执行，结果转 tool 消息存入 MessageStore，续轮继续
- 实现中断处理：通过 `AbortController` 中止 LLM 流，标记 pending 工具为 cancelled，追加 interrupted assistant 消息
- 实现 Max Steps 限制：默认 50 步，达到限制时 `toolChoice: "none"` + 追加 MAX_STEPS_PROMPT
- 实现 ToolContext 构建：从配置注入 workspaceRoots、maxFileSize、toolTimeoutMs 等参数

## Capabilities

### New Capabilities
- `agent-loop`: 本地 Agent 循环核心，驱动 LLM 推理与工具调用的多轮交互，包含主循环逻辑、流式事件处理、工具执行集成、中断处理和 Max Steps 限制
- `tool-adapter`: LLM 层与 core 层之间的类型适配层，处理 ToolCall/ToolDefinition 的字段映射转换

### Modified Capabilities

## Impact

- **新增代码**：`src/agent/agentLoop.ts`、`src/agent/toolAdapter.ts`，`src/agent/` 目录需新建
- **依赖模块**：集成 Phase 1 的 `LLMProvider`/`LLMEvent`/`LLMRequest` 和 Phase 2 的 `MessageStore`/`loadHistoryForLLM`，以及现有的 `ToolRouter`/`ToolRegistry`/`EventBus`/`ToolContext`
- **配置依赖**：需要读取 `yunxiaoAgent.agent.maxSteps` 配置（需确认是否已在 package.json 注册）
- **不修改现有文件**：本阶段仅新建文件，不改动 Phase 1/Phase 2 和现有 core/tools 代码
