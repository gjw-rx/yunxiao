## Why

当前插件依赖云端 LangGraph 服务进行 LLM 推理，插件端仅负责工具执行和前端渲染。根据重构总体方案，需将架构改为"本地全栈 Agent"——直接对接 OpenAI 兼容的 LLM Provider。本变更覆盖 Phase 0（准备工作）和 Phase 1（模型连接层），为后续 Agent Loop、记忆管理、上下文压缩等模块奠定基础。

## What Changes

- 新建 `src/llm/`、`src/agent/`、`src/memory/`、`src/skill/`、`src/config/` 目录结构
- 备份 `aiClient.ts`、`sessionManager.ts`、`chatPanel.ts` 三个关键文件
- 新增 `src/llm/types.ts`：定义 `LLMMessage`、`LLMRequest`、`LLMEvent`、`ToolDefinition`、`LLMProvider` 接口
- 新增 `src/config/modelConfig.ts`：从 VSCode 配置读取模型设置（provider/model/apiKey/baseURL/temperature/maxTokens），支持配置变更监听
- 新增 `src/llm/openaiProvider.ts`：实现 `LLMProvider` 接口，构建 OpenAI `/v1/chat/completions` 请求体，发起 fetch 请求
- 新增 `src/llm/streamParser.ts`：解析 SSE `data:` 行，提取 `delta.content`/`delta.tool_calls`/`finish_reason`/`usage`，以 AsyncGenerator 逐事件 yield
- 新增 `src/llm/provider.ts`：`createProvider(config)` 工厂函数，目前支持 OpenAI 兼容，预留扩展点
- 在 `package.json` 中注册 `yunxiaoAgent.model.*` 配置项

## Capabilities

### New Capabilities
- `llm-connection-layer`: LLM Provider 抽象层——定义统一的请求/响应/流式事件类型，实现 OpenAI 兼容 Provider（请求构建、fetch、SSE 流式解析），通过工厂函数创建 Provider 实例
- `model-configuration`: 模型配置管理——从 VSCode 配置读取模型连接参数（provider/model/apiKey/baseURL/temperature/maxTokens），支持配置变更监听与回调通知

### Modified Capabilities
<!-- 本次变更不修改已有 spec 的需求层行为。Task 0+1 仅新建模块，不触碰已有功能。 -->

## Impact

- **新增代码**：`src/llm/`（4 文件）、`src/config/`（1 文件）、5 个新目录
- **修改文件**：`package.json`（新增 `yunxiaoAgent.model.*` 配置项）
- **备份文件**：`aiClient.ts`、`sessionManager.ts`、`chatPanel.ts` 备份至 `docs/backup/`
- **不触碰**：现有工具实现（`src/tools/`）、核心模块（`src/core/`）、前端（`src/chatPanel.ts`）逻辑不变
- **依赖**：使用 Node.js 原生 `fetch`（Node 18+），不引入额外 npm 依赖
- **编译**：新代码需通过 `tsc --noEmit` 类型检查
