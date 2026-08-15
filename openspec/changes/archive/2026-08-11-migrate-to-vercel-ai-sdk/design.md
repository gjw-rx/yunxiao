## Context

当前扩展已将 Agent、工具和会话运行在本地，但模型连接层仍由 `OpenAIProvider`、`parseSSEStream` 和自定义 LLM 类型共同实现。该层只覆盖 OpenAI Chat Completions 风格的流式协议，Provider-specific reasoning、usage、错误与取消细节需要在项目中持续维护。

本次变更采用 Vercel AI SDK 的 Core 与 OpenAI-compatible Provider 作为模型协议边界。它不改变产品运行时的职责划分：`AgentLoop` 仍控制每轮历史重载、上下文压缩、最大步数、doom loop 与并行策略；`ToolRouter` 仍是所有本地工具执行的唯一入口；`MessageStore` 仍是会话和压缩检查点的持久化真相。

当前 `engines.vscode` 为 `^1.99`，对应 Extension Host Node 20。AI SDK 7.x 需要 Node 22，因此本次必须使用 Node 18+ 兼容的 AI SDK 6.x 系列。OpenCode 的上游实现也以 AI SDK Core `streamText` 作为 Provider/stream 适配层，同时保留其自有外层 Session loop、权限与会话处理器；该边界是本设计的参考。

## Goals / Non-Goals

**Goals:**

- 以 AI SDK 6.x 统一 OpenAI-compatible 模型请求、流式响应、reasoning、usage、工具调用和取消协议。
- 无破坏地保留现有 `yunxiaoAgent.model.provider=openai`、`baseURL`、API Key、模型名称和 AgentLoop 调用契约。
- 将 AI SDK `fullStream` 归一化为现有 `LLMEvent` 与 EventBus 事件，避免 ChatPanel 协议重写。
- 让已有 `ToolSchema.parameters` 成为 AI SDK 的输入 Schema，同时确保本地执行仍只经过 `ToolRouter`。
- 为 Provider 兼容性、使用量、工具调用、取消和 legacy fallback 建立可回归的测试。

**Non-Goals:**

- 不使用 AI SDK `ToolLoopAgent` 替换当前 `AgentLoop`。
- 不使用 AI SDK UI 替换 VSCode Webview 和 EventBus。
- 不迁移 `MessageStore`、`SessionFileStore`、`HistoryLoader` 或 compaction 的持久化格式。
- 不以 AI SDK `needsApproval` 替换 ApprovalGateway 的会话授权、作用域授权和破坏性二次确认。
- 不在本次一次性接入所有原生 Provider；首先保证 OpenAI-compatible 路径，再按需要增量添加 Provider 包。
- 不启用 AI SDK telemetry 上报；项目既有日志和审计继续是默认可观测性来源。

## Decisions

### 1. 将 AI SDK 限定为模型协议层，而非完整 Agent 框架

新增 `AISDKProvider`（或等价命名的适配器）实现现有 `LLMProvider.chatCompletion(request)`。它将已有 `LLMRequest` 转为 AI SDK `streamText` 输入，并将 `fullStream` 转回已有 `LLMEvent` 异步生成器。

这样 `AgentLoop`、`Compaction` 和 ChatPanel 不需要同时迁移。该适配器稳定后，项目可以删除手写 OpenAI HTTP/SSE 实现，而不把 Agent 产品语义绑定到 SDK 的 Agent API。

替代方案是直接改用 `ToolLoopAgent`。不采用，因为它的自动多步循环、消息维护与审批暂停语义会重叠或改变当前持久化历史、压缩时机、doom loop 和工具并行策略。

### 2. 固定 AI SDK 6.x，并最小化初始依赖面

初始依赖固定为经 Node 20 验证的 AI SDK 6.x、匹配的 `@ai-sdk/openai-compatible` 和满足 peer dependency 的 `zod`。依赖必须精确锁定，不能使用 `latest` 或跨 major 浮动范围。打包仅导入 OpenAI-compatible Provider；原生 Provider 包在对应 Provider 被正式支持时再加入。

替代方案是直接使用 AI SDK 7.x。因其 Node 22 最低要求与 VS Code 1.99 的 Extension Host 不兼容，除非单独提高扩展最低 VS Code 版本，否则不采用。

### 3. 保持 OpenAI-compatible 配置为默认兼容路径

`provider=openai` 继续接受现有 API Key、baseURL、model、temperature、maxTokens 与 reasoning 配置。适配器以 `createOpenAICompatible` 创建命名 Provider，并将其映射到 SDK 的 `maxOutputTokens`、Provider Options 和 AbortSignal。

未来原生 Provider 通过一个显式 Model Factory/Capability Registry 接入；调用方只依赖 `LLMProvider`，不得在 AgentLoop 中出现 Provider-specific 条件分支。

### 4. 使用 `fullStream` 作为唯一流式事实来源

适配器仅从 AI SDK `fullStream` 归一化事件：

| AI SDK stream part  | 现有 LLMEvent / 行为                         |
| ------------------- | -------------------------------------------- |
| `text-delta`      | `textDelta`                                |
| `reasoning-delta` | `reasoningDelta`                           |
| `tool-call`       | `toolCall`，将已校验输入序列化为 arguments |
| `finish`          | `finish` 与一次权威 usage 事件             |
| `error`           | `error`                                    |
| `abort`           | 结束当前生成，不再产生新的工具执行           |

`tool-input-*` 仅用于适配器内部收集，不扩展现有 Webview 协议。`finish-step` 不得与最终 `finish` 重复落 token 账；每个 `chatCompletion` 最多产生一条权威 usage 事件。

### 5. 仅适配 Tool Schema，不授权 AI SDK 执行本地工具

现有 `ToolRegistry` 的 `ToolSchema` 转为 AI SDK `tool`/`jsonSchema` 定义时不提供 `execute` 回调。AI SDK 负责让模型看到 Schema 并产生结构化 tool-call；`AgentLoop` 仍按现有批处理策略把调用交给 `ToolRouter.route()`。

该决策防止 SDK 自动执行绕过 SecurityAudit、ApprovalGateway、ToolExecutionJournal、结果脱敏/截断，且保留只读工具有限并行、写/执行/破坏性工具串行的现有策略。

替代方案是把 `ToolRouter.route()` 直接作为 AI SDK `execute`。不在本期采用，因为 SDK 的自动 Tool 调度不能表达当前按 `canParallel` 区分的批处理策略，且 AI SDK approval 的二次模型调用语义与当前审批 UI 不一致。

### 6. 保持领域消息格式与压缩策略独立

`MessageStore` 继续持久化项目的 `Message` union。适配器在每次调用前把 HistoryLoader 的 `LLMMessage[]` 转为 AI SDK `ModelMessage[]`，在模型返回后把 Tool Call/Tool Result 以现有格式存回 MessageStore。Compaction 使用同一适配器调用摘要模型，但保持现有触发阈值、摘要模板和检查点格式。

替代方案是直接存储 AI SDK Message/UIMessage。由于 SDK 大版本可能改变消息内容部件和工具字段，同时无法保存项目的审批、台账和 token 分摊语义，故不采用。

## Risks / Trade-offs

- [AI SDK 版本升级导致 Extension Host 不可加载] → 固定 6.x 精确版本，CI 与 VS Code 1.99 Extension Host 运行 smoke test；未验证 Node 22 前禁止升级至 7.x。
- [Provider 的流事件与当前 OpenAI SSE 事件不同] → 用录制的 OpenAI-compatible、reasoning、tool-call、usage、错误和取消 fixture 覆盖适配器，并保留 legacy fallback。
- [最终 usage 与 step usage 重复记账] → 明确仅最终 `finish` 的 totalUsage 为权威账，增加每次模型调用一次 usage 的测试断言。
- [Tool Schema 转换或 SDK 自动执行绕过安全边界] → 初始 AI SDK Tool 不注册 `execute`；安全、审批、审计、台账和结果治理测试必须保持通过。
- [AI SDK 依赖导致 VSIX 变大或激活变慢] → 只引入通用兼容 Provider，使用现有 esbuild tree-shaking，并记录 VSIX 大小与激活/首 token 延迟基线。
- [legacy fallback 长期保留形成双实现] → fallback 仅作为临时迁移开关；连续两个发布版本无 P0/P1 兼容问题后，另建变更移除。
- [遥测意外记录 prompt 或工具定义] → 初始调用显式关闭 experimental telemetry，不添加第三方 telemetry integration。

## Migration Plan

1. 记录现有模型流、工具调用、usage、取消和错误的 fixture，并先增加不依赖网络的契约测试。
2. 安装并锁定 AI SDK 6.x、OpenAI-compatible Provider 与 Schema peer dependency；确认 esbuild 产物和 VS Code 1.99 Extension Host 均可加载。
3. 实现 Model Factory、`LLMMessage`/`ModelMessage` 转换器和 `fullStream`/`LLMEvent` 适配器；保留 `LLMProvider` 接口。
4. 增加 `model.runtime` 迁移开关，默认 AI SDK，允许受控回退 legacy；对相同 fixtures 比较旧/新事件序列与 token 结果。
5. 将 ToolSchema 通过 AI SDK JSON Schema 暴露给模型，但继续使用 AgentLoop→ToolRouter 的既有执行路径；验证审批、审计、并行和台账。
6. 将 compaction 摘要调用切换到新适配器，验证压缩检查点、历史重放和 token 累计。
7. 在 OpenAI-compatible、DeepSeek reasoning、无 usage、tool-call、网络错误和用户取消路径均通过后，使 AI SDK 路径成为唯一默认实现。
8. 稳定期后，单独发起移除 legacy provider/parser 和迁移开关的 OpenSpec change。

回滚策略：将 `model.runtime` 切换为 `legacy`，无需改动持久化消息、工具定义、审批记录或 Webview 协议。若适配器已经写入新字段，字段必须是向后兼容的可选字段。

## Open Questions

- 初始版本是否仅公开 `openai` Provider 配置，还是同时公开 `anthropic`、`alibaba` 等原生 Provider ID？本设计默认前者，后者在 capability registry 与凭证体验确定后再加入。
- legacy fallback 开关是否只在开发/预发布环境显示，还是暴露为正式配置项？默认作为迁移期高级设置，并在稳定后删除。
- 是否在本次把 cache read/write token 展示到 Webview，还是仅持久化并写日志？本设计要求保留数据，UI 展示由现有 token UI 兼容性决定。
