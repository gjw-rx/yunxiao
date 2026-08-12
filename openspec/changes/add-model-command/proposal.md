## Why

插件已支持配置多个模型（`ModelConfigStore`，存储于 `.yunForce/modelConfig/models.json`），但切换当前使用的模型只能进入设置页操作；对话过程中没有快速切换模型的入口，多模型场景下体验割裂。

## What Changes

- 新增内置斜杠命令 `/model`（基础功能分组）：输入 `/` 可从菜单选中，或直接输入 `/model` 触发。
- 选中 `/model` 后弹出模型选择列表（QuickPick），仅列出已启用（`enabled`）的模型，标记当前默认项。
- 选择后持久化切换当前默认模型（复用 `ModelConfigStore.setDefaultModel` + 扩展侧 `applyModelConfig`）：写回 `.yunForce/modelConfig/models.json`，重建 LLM Provider 并更新 AgentLoop 配置。
- 切换生效时机：进行中的流式回复不受影响（AgentLoop 对进行中的 run 持有 provider 快照），切换后新发送的消息使用新模型；对话面板头部模型名（`modelInfo`）同步更新。
- Webview 协议新增 `switchModel` 消息；`SlashCommand.action` 类型扩展 `'switchModel'`。
- API Key 全程不进入 Webview：QuickPick 仅展示模型名 / Provider / 是否默认，密钥仍只存 SecretStorage。

## Capabilities

### New Capabilities
- `model-switching`: 通过 `/model` 斜杠命令在已配置模型间切换当前默认模型的完整行为——候选模型来源、选择交互、持久化、生效时机与 API Key 安全边界。

### Modified Capabilities
- `slash-command-menu`: 内置基础命令表新增 `/model` 命令；该命令为特殊动作命令，选中时触发 `switchModel` 动作（弹模型选择）而非发送消息或回填输入框。

## Impact

- 代码：
  - `src/chat/slashCommands.ts`：`SlashCommand.action` 联合类型加 `'switchModel'`，`BASIC_COMMANDS` 新增 `/model` 项。
  - `src/webview-ui/protocol.ts`：webview 侧 `SlashCommand.action` 同步扩展；新增 `SwitchModelMessage` 并入 `WebviewToHostMessage`。
  - `src/webview-ui/components/chat/MessageInput.tsx`：`selectSlashCommand` 的 action 分发新增 `switchModel` 分支。
  - `src/chatPanel.ts`：`_handleMessage` 新增 `switchModel` 处理（读模型列表 → QuickPick → 切换 → 回调应用）。
  - `src/extension.ts`：无改动（`applyModelConfig` / `modelStore` / `refreshModelInfo` 均已装配注入）。
- 测试：`src/test/chat/slashCommands.test.ts` 断言新增 `/model` 命令；chatPanel 侧补 `switchModel` 处理测试。
- 无新增依赖；无破坏性变更。
