## Why

当前上下文压缩以固定窗口、消息数量和历史消息本身的粗略 token 数触发，未计入系统提示词、工具 schema 与保留输出空间；模型实际能力变化时也不会同步阈值。工具调用边界的保留逻辑不完整，可能把孤立的 `assistant.tool_calls` 或 `tool` 结果发送给模型，造成协议错误。

现在需要以每个模型的真实最大上下文为基准，重建可观察、可手动触发且保持工具调用完整性的压缩机制。

## What Changes

- **BREAKING** 移除现有基于固定 `contextWindow`、`buffer`、`keepTokens` 与消息数量的压缩判定，改为按完整 LLM 请求 token 估算值和模型最大上下文的比例触发。
- 在模型档案中增加可手动填写的“最大上下文 token”，默认 `262144`（256K），并在切换模型时同步给 AgentLoop。
- 在 VSCode 原生设置中提供自动压缩开关、触发比例（默认 75%）和尾部保留比例；不将这些参数放入插件设置 Webview。
- 重建压缩流水线：从最新压缩检查点重建有效历史、生成增量摘要、按完整工具调用链选取尾部、清理孤立工具对、仅在摘要成功后追加新检查点。
- 增加 `/compact` 手动命令；命令不进入会话历史，且在对话运行中拒绝执行。
- 为压缩入口、判定、摘要、工具对清理、成功/失败与手动命令写入可定位日志。
- 沉淀 Hermes Agent 对上下文预算、检查点摘要和工具配对清理的调研结论。

## Capabilities

### New Capabilities

- `context-compaction`: 基于完整请求预算的自动/手动上下文压缩、检查点摘要和工具调用链完整性保障。

### Modified Capabilities

- `plugin-configuration-management`: 模型档案增加最大上下文 token，保留安全存储边界。
- `slash-command-menu`: 增加可直接执行且不进入会话消息的 `/compact` 命令。
- `memory-history-loader`: 加载最新检查点代表的有效上下文，供重新压缩和 LLM 历史转换共同使用。

## Impact

- 受影响代码：`src/agent/compaction.ts`、`src/agent/agentLoop.ts`、`src/agent/tokenEstimator.ts`、`src/memory/*`、`src/config/modelConfig*`、`src/extension.ts`、`src/chatPanel.ts`、`src/chat/slashCommands.ts`、`src/webview-ui/*`、`package.json` 与对应测试。
- 不新增运行时依赖；继续复用现有 token 估算器和 LLM Provider。
- 现有 `yunxiaoAgent.compaction.keepTokens`、`buffer`、`messageThreshold` 不再参与压缩判定，改由新的 VSCode 设置承载。
