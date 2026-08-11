## 1. 迁移准备与兼容基线

- [x] 1.1 为当前 OpenAI-compatible 流记录文本、reasoning、tool call、usage、finish、错误和取消 fixture，并为现有事件序列建立回归测试基线。
- [x] 1.2 在 `package.json` 与 lockfile 中添加并精确锁定 Node 20 兼容的 AI SDK 6.x、`@ai-sdk/openai-compatible` 和 `zod`，确认现有 esbuild 打包配置可处理这些依赖。
- [x] 1.3 增加临时 `model.runtime` 配置解析与校验，默认选择 `ai-sdk`，仅允许显式 `legacy` 回退，并补充配置测试。
- [ ] 1.4 在 VS Code 1.99 Extension Host 中加载扩展，记录迁移前后 VSIX 大小、激活时间和首 token 延迟基线。

## 2. AI SDK 模型运行时

- [x] 2.1 扩展 `src/llm/types.ts` 的最小必要契约以承载归一化 finish reason、provider metadata 和可选 cache token 明细，同时保持既有调用方兼容。
- [x] 2.2 实现 AI SDK Model Factory：将既有 `provider=openai`、API Key、baseURL、model 与生成参数映射到 OpenAI-compatible AI SDK model，隔离所有 Provider-specific 选项。
- [x] 2.3 实现 `LLMMessage` 到 AI SDK `ModelMessage` 的转换器，覆盖 system、user、assistant tool call 和 tool result 历史消息。
- [x] 2.4 实现 `fullStream` 到 `LLMEvent` 的适配器，按顺序转换 text、reasoning、complete tool call、usage、finish 和 error，并确保每次模型调用只产生一条权威 usage 事件。
- [x] 2.5 将 AgentLoop abort signal 传入 AI SDK 调用，处理 abort、网络错误和 provider warning，并在每个关键分支使用项目 logger 输出中文可定位日志。
- [x] 2.6 在现有 Provider 工厂中接入 AI SDK runtime 与 legacy fallback，保持 `LLMProvider` 调用契约不变。

## 3. Tool Schema 与安全执行边界

- [x] 3.1 改造 `src/agent/toolAdapter.ts`，将 `ToolRegistry` 的名称、描述和 JSON Schema 参数转换为 AI SDK-compatible tool definitions，禁止为本地工具注册 AI SDK `execute` 回调。
- [x] 3.2 将 AI SDK 归一化 tool call 接入现有 AgentLoop 批处理路径，继续由 `ToolRouter.route()` 负责参数校验、审计、审批、台账和结果治理。
- [x] 3.3 保持并验证只读工具有限并行、写/执行/破坏性工具串行的现有调度策略，确保 AI SDK integration 不会重复或提前执行工具。
- [x] 3.4 为 AI SDK Tool Schema、无效参数、多个 tool call、审批拒绝、危险终端命令和执行台账补充单元与集成测试。

## 4. Token、压缩与会话兼容

- [x] 4.1 让 token accounting 使用 AI SDK 最终 usage，保留现有 reasoning/tool/model/user/context 分摊算法，并在 usage 缺失时继续使用估算器。
- [x] 4.2 在 `TokenUsageSnapshot`、消息存储和恢复逻辑中以可选字段持久化 cache read/write token，保证旧历史消息仍可加载。
- [x] 4.3 将 compaction 摘要模型调用切换为 AI SDK runtime，保持既有摘要模板、触发阈值、检查点格式和历史重放语义。
- [x] 4.4 为 usage 缺失、reasoning 缺失、cache token 存在/缺失、压缩后重载和会话累计补充回归测试。

## 5. 验证与发布准备

- [x] 5.1 使用同一组 fixtures 对 legacy 与 AI SDK runtime 的 EventBus 事件、工具调度结果、token 账和持久化消息进行差异比对，修复不兼容项。
- [x] 5.2 验证 OpenAI-compatible、DeepSeek reasoning、tool call、网络错误和用户取消路径均满足本 change 的 specs。
- [x] 5.3 运行 `npm run compile`、相关单元测试和完整 `npm test`，修复所有类型、lint 与行为回归。
- [ ] 5.4 打包 VSIX 并在 VS Code 1.99 Extension Host 中完成 smoke test；确认 runtime fallback 不改变 Webview、审批记录、工具结果和历史消息格式。
