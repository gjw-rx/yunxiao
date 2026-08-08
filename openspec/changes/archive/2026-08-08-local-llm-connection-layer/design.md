## Context

当前 VSCode 插件通过 `AIClient`（`src/aiClient.ts`）与云端 LangGraph 服务通信，LLM 推理完全在云端完成。插件端通过 SSE 事件流接收 LLM 输出，通过 HTTP 回传工具执行结果。

重构第一阶段（Phase 0 + Phase 1）的目标是在本地建立 LLM 连接层，使插件能直接对接 OpenAI 兼容的 LLM Provider（OpenAI/DeepSeek/通义千问等），为后续 Agent Loop 替代云端编排做准备。

现有约束：
- TypeScript strict 模式，`module: Node16`，`target: ES2022`
- 不引入额外 npm 依赖（使用 Node.js 原生 `fetch`）
- 保持与现有 `ToolSchema`/`EventBus`/`BaseTool` 类型的兼容性
- VSCode 引擎版本 `^1.99.0`，需确保 API 兼容

## Goals / Non-Goals

**Goals:**
- 定义统一的 LLM 类型体系（消息、请求、流式事件、工具定义、Provider 接口）
- 实现 OpenAI `/v1/chat/completions` 兼容 Provider，支持流式响应
- 实现 SSE 流式解析器，正确处理 `delta.content`/`delta.tool_calls`/`finish_reason`/`usage`
- 实现模型配置管理，从 VSCode 配置读取并监听变更
- 通过工厂函数创建 Provider 实例，预留扩展点
- 新建目录结构，备份关键文件

**Non-Goals:**
- 不实现 Agent Loop（Phase 3）
- 不实现记忆管理/消息存储（Phase 2）
- 不删除现有云端代码（Phase 6）
- 不实现上下文压缩（Phase 5）
- 不实现非 OpenAI 兼容的 Provider（如 Anthropic 原生 API）
- 不实现 token 精确计数（使用字符数/4 估算，Phase 5）

## Decisions

### 决策 1：使用原生 fetch + 手动 SSE 解析，不引入 AI SDK

**选择**：使用 Node.js 原生 `fetch` 发起请求，手动解析 SSE `data:` 行。

**理由**：不引入 `openai` SDK 或 `ai` SDK 等额外依赖，保持插件轻量。OpenAI 流式响应格式简单（SSE `data:` 行 + JSON chunk），手动解析完全可行且可控。

**替代方案**：使用 `openai` npm 包。否决原因：引入 ~50MB 依赖，且与 DeepSeek/通义千问等兼容服务的适配需要额外配置。

### 决策 2：LLMMessage 与现有 ToolSchema 分离

**选择**：在 `src/llm/types.ts` 中独立定义 `LLMMessage`、`ToolDefinition` 等类型，不复用 `src/core/types.ts` 中的 `ToolCall`/`ToolResult`。

**理由**：LLM 层的消息格式（OpenAI chat completions 格式）与工具执行层的格式不同。LLM 层的 `ToolDefinition` 是给 LLM 看的工具声明（JSON Schema），而 `ToolSchema` 是插件内部的工具元数据。后续 Agent Loop 会负责两者之间的转换。

### 决策 3：tool_calls 增量合并

**选择**：在 `streamParser.ts` 中维护一个 `Map<index, ToolCallAccumulator>`，跨多个 SSE chunk 合并同一 tool_call 的 `function.name` 和 `function.arguments` 增量片段。

**理由**：OpenAI 流式响应中，一个 tool_call 可能被分到多个 `delta.tool_calls` chunk 中，`index` 字段标识属于同一个 tool_call。必须合并后才能得到完整的工具调用信息。

**替代方案**：在 Provider 层而非 Parser 层合并。否决原因：Parser 层更合适，因为它已经在逐行解析 SSE，合并逻辑与解析逻辑内聚。

### 决策 4：Provider 工厂模式

**选择**：`createProvider(config: ModelConfig): LLMProvider` 工厂函数，根据 `config.provider` 字段返回对应实现。目前只实现 `openai` 一种，但通过 switch 预留扩展。

**理由**：未来可能需要支持 Anthropic 原生 API（非 OpenAI 兼容格式），工厂模式让新增 Provider 不影响调用方。

### 决策 5：ModelConfig 使用 VSCode workspace configuration

**选择**：从 `vscode.workspace.getConfiguration('yunxiaoAgent.model')` 读取配置，通过 `onDidChangeConfiguration` 监听变更。

**理由**：与现有配置项（`yunxiaoAgent.maxFileSize` 等）保持一致的模式，利用 VSCode 原生能力，无需引入额外存储方案。

### 决策 6：LLMEvent 使用 discriminated union

**选择**：`LLMEvent` 定义为 `{ type: "textDelta"; ... } | { type: "toolCall"; ... } | ...` 联合类型。

**理由**：discriminated union 让 TypeScript 能在 switch case 中正确收窄类型，避免运行时类型检查错误。

## Risks / Trade-offs

- **[API Key 安全]** API Key 存储在 VSCode 配置中，可能被其他扩展或日志读取。-> 缓解：不将 API Key 写入日志，错误消息中脱敏。后续可考虑使用 VSCode SecretStorage。
- **[网络中断]** 流式响应中途网络断开，fetch 会抛出 AbortError 或网络错误。-> 缓解：Provider 将网络错误包装为 `LLMEvent { type: "error" }`，由上层 Agent Loop 决定重试或报告。
- **[tool_calls 增量解析复杂性]** 不同 LLM Provider 的 tool_calls 分片行为可能不同（有些一次返回完整 tool_call，有些分多片）。-> 缓解：严格按照 OpenAI 规范的 `index` 字段合并，对于不遵循规范的 Provider 在 Provider 层适配。
- **[Token 估算不精确]** 后续 Phase 5 的上下文压缩需要 token 估算，但本阶段不实现。-> 可接受：Phase 5 再实现简单估算。
- **[配置项未生效]** 新增的 `yunxiaoAgent.model.*` 配置项在本阶段不会被任何代码消费（Agent Loop 尚未实现）。-> 可接受：配置先行，后续 Phase 直接使用。
