## 1. 准备工作（Phase 0）

- [x] 1.1 新建目录结构：`src/llm/`、`src/agent/`、`src/memory/`、`src/skill/`、`src/config/`
- [x] 1.2 备份关键文件：`src/aiClient.ts`、`src/core/sessionManager.ts`、`src/chatPanel.ts` 复制到 `docs/backup/`

## 2. LLM 类型定义（Task 1.1）

- [x] 2.1 创建 `src/llm/types.ts`
- [x] 2.2 定义 `LLMMessage` 联合类型（system/user/assistant/tool，discriminated union）
- [x] 2.3 定义 `LLMRequest` 接口（model/messages/tools/toolChoice/temperature/maxTokens/stream）
- [x] 2.4 定义 `LLMEvent` 联合类型（textDelta/toolCall/usage/finish/error）
- [x] 2.5 定义 `ToolDefinition` 类型（name/description/parameters）
- [x] 2.6 定义 `LLMProvider` 接口（`chatCompletion(request): AsyncGenerator<LLMEvent>`）

## 3. 模型配置管理（Task 1.2）

- [x] 3.1 创建 `src/config/modelConfig.ts`
- [x] 3.2 定义 `ModelConfig` 接口（provider/model/apiKey/baseURL/temperature/maxTokens）
- [x] 3.3 实现 `getModelConfig(): ModelConfig`，从 `vscode.workspace.getConfiguration('yunxiaoAgent.model')` 读取
- [x] 3.4 实现 `onModelConfigChange(callback): Disposable`，监听配置变更
- [x] 3.5 在 `package.json` 的 `contributes.configuration.properties` 中注册 6 个 `yunxiaoAgent.model.*` 配置项

## 4. SSE 流式解析器（Task 1.4）

- [x] 4.1 创建 `src/llm/streamParser.ts`
- [x] 4.2 实现 `parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<LLMEvent>`
- [x] 4.3 实现 SSE 行分割：按 `\n` 分割缓冲区，提取 `data: ` 前缀行
- [x] 4.4 处理 `[DONE]` 终止标记
- [x] 4.5 解析 `choices[0].delta.content` -> `textDelta` 事件
- [x] 4.6 解析 `choices[0].delta.tool_calls`，按 `index` 合并增量片段 -> `toolCall` 事件
- [x] 4.7 解析 `choices[0].finish_reason` -> `finish` 事件
- [x] 4.8 解析 `usage` -> `usage` 事件

## 5. OpenAI 兼容 Provider（Task 1.3）

- [x] 5.1 创建 `src/llm/openaiProvider.ts`
- [x] 5.2 实现 `OpenAIProvider` 类，构造函数接收 `ModelConfig`
- [x] 5.3 实现 `chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent>`
- [x] 5.4 构建 OpenAI `/v1/chat/completions` 请求体（messages 转换、tools 转换为 function 格式、stream: true）
- [x] 5.5 设置请求头（Authorization: Bearer + Content-Type: application/json）
- [x] 5.6 发起 fetch 请求，将 response.body 传给 `parseSSEStream`
- [x] 5.7 处理非 OK HTTP 响应（yield error 事件）
- [x] 5.8 处理网络错误（yield error 事件）

## 6. Provider 工厂（Task 1.5）

- [x] 6.1 创建 `src/llm/provider.ts`
- [x] 6.2 实现 `createProvider(config: ModelConfig): LLMProvider` 工厂函数
- [x] 6.3 `config.provider === "openai"` 时返回 `OpenAIProvider` 实例
- [x] 6.4 未知 provider 抛出描述性错误

## 7. 编译验证与测试（Task 1.6）

- [x] 7.1 运行 `tsc --noEmit` 确认所有新文件无类型错误
- [x] 7.2 运行 `npm run lint` 确认无 lint 错误
- [x] 7.3 编写 `src/llm/streamParser.ts` 单元测试（SSE 解析、tool_calls 合并、DONE 处理）
- [x] 7.4 编写 `src/llm/openaiProvider.ts` 单元测试（请求体构建、错误处理）
- [x] 7.5 运行全部测试确认通过
