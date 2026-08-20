## 1. 建立协议回归基线与依赖

- [x] 1.1 为 Anthropic Messages 准备离线 Provider mock/录制 fixture，覆盖文本、reasoning、单个与并行工具调用、finish、流内错误、取消、完整 usage、cache creation 与大 cache read；先写出当前实现失败的测试。
- [x] 1.2 选择与已锁定 `ai@6.x` 和 VS Code `^1.99` Extension Host 兼容的 `@ai-sdk/anthropic` 版本并精确锁定，更新 lockfile，验证依赖树无 peer/engine 冲突。
- [x] 1.3 增加 Extension Host 模型运行时加载 smoke test，验证 OpenAI-compatible 与 Anthropic Provider 包均能在最低支持运行时加载。

## 2. 扩展模型配置与 Provider 分派

- [x] 2.1 扩展模型配置共享类型、存储校验与设置页协议以接受 `openai | anthropic`，为 Anthropic 空地址应用 `https://api.anthropic.com/v1`，保持旧 OpenAI 档案读取结果与 SecretStorage 行为不变。
- [x] 2.2 在配置保存和 `createProvider` 两层拒绝 `provider=anthropic` 与 `runtime=legacy`，补充未知 provider、错误 runtime 组合和无网络请求的单元测试。
- [x] 2.3 更新设置页模型表单的 Provider 选择、默认地址与中文校验反馈，验证 API Key 仍只显示已配置状态且切换 Provider 不泄露或误改其他模型档案。

## 3. 完善统一工具消息契约

- [x] 3.1 先补充消息存储、历史加载与 AI SDK 消息转换测试，覆盖新 tool result 保存 `toolName`、旧记录按 `toolCallId` 恢复名称以及孤立结果不发送空工具名。
- [x] 3.2 为 LLM/内存/会话 tool result 契约增加可兼容旧数据的 `toolName`，在 AgentLoop 写入实际工具名，并在历史加载阶段从配对 assistant tool call 恢复旧记录名称。
- [x] 3.3 更新 AI SDK 消息转换器，使同一统一历史可生成 OpenAI-compatible tool message 与 Anthropic 合法 tool use/tool result；验证并行同名调用按调用 ID 独立往返且仍只经 ToolRouter 执行。

## 4. 实现 Anthropic AI SDK 模型运行时

- [x] 4.1 重构 AI SDK 模型工厂为显式 provider 分派，保留现有 OpenAI-compatible 创建逻辑，并用 `createAnthropic` 创建配置了 model、apiKey 与 baseURL 的原生 Messages 模型。
- [x] 4.2 将 provider options 构造改为按 provider key 隔离：OpenAI/DeepSeek 维持既有行为，Anthropic 将 `low/medium/high` 映射为原生 `effort`，未设置或内部无等价档位时不伪造参数并记录诊断。
- [x] 4.3 仅对 Anthropic 的最后一个可缓存内容块注入 5 分钟 ephemeral cache breakpoint，确保 metadata 不持久化、不下发 Webview，且 OpenAI-compatible 请求对象完全不变。
- [x] 4.4 复用 `fullStream` 适配器完成 Anthropic text、reasoning、tool call、finish/error 与 abort 的统一事件映射，补齐 provider/model/阶段日志并验证日志不含密钥、header 或完整请求体。

## 5. 对齐 usage、token 与缓存口径

- [x] 5.1 在流适配层验证并实现 Anthropic usage 归一化：总输入为未缓存输入 + cache read + cache creation，同时映射 noCache/cacheRead/cacheWrite/output/thinking，且每次调用只发一条最终权威 usage。
- [x] 5.2 扩充字段校验与回退测试，覆盖缺失 cache/thinking、非法负数、缓存组成超过总输入、最终 usage 缺失和 reasoning 文本估算；无效可选字段须省略并记录中文诊断。
- [x] 5.3 验证 Anthropic tokenUsage 按 `provider=anthropic` 和实际 model 持久化，并复用会话累计与工作区日/周/月统计；cache read/write 只作为输入侧明细，不重复增加 total。

## 6. 端到端回归与交付验证

- [x] 6.1 增加 OpenAI-compatible 运行时 parity 回归，验证请求参数、reasoning、工具、usage/cache、取消与 legacy fallback 未因 provider 分派而改变。
- [x] 6.2 增加 Anthropic 端到端 AgentLoop 测试：多轮对话 → Claude tool use → ToolRouter 结果 → tool result 回传 → 最终文本，并验证事件顺序、审批边界和 token 快照。
- [x] 6.3 运行 `npm test` 与 `npm run compile`，修复所有类型、lint、打包和测试问题，并确认新增/修改源码具备中文文件职责、完整 JSDoc 与关键步骤日志。
- [x] 6.4 使用 `openspec validate add-anthropic-messages-protocol --strict` 校验 change artifacts，记录 Anthropic 官方端点、Messages/cache/usage 字段与 AI SDK Provider 版本依据，确认实现满足全部 scenarios。
