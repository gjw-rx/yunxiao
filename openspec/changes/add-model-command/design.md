## Context

- 多模型配置已落地：`ModelConfigStore` 将非敏感字段持久化到 `.yunForce/modelConfig/models.json`，每个模型 API Key 存 SecretStorage；`setDefaultModel(modelId)` 切换默认模型并返回完整 `ModelConfig`（含密钥）；`getSettingsView()` 提供模型列表视图（含 `enabled` / `isDefault` / `apiKeyConfigured`）。
- 扩展装配（`src/extension.ts`）已具备完整的「模型配置应用」闭环：`applyModelConfig(config)` 重建 LLM Provider、更新 AgentLoop 配置并调用 `provider.refreshModelInfo()`；`modelStore` 与 `onModelConfigSaved: applyModelConfig` 均已通过 `provider.setSettingsDeps(...)` 注入 `ChatViewProvider`。
- Slash 命令机制：`src/chat/slashCommands.ts` 的 `buildSlashCommandGroups` 组装基础功能 / 子智能体 / SKILL与命令三个分组；webview 侧 `MessageInput.selectSlashCommand` 按 `action` 分发——`newSession` / `stopStream` 直接 `post` 消息，skill 命令生成引用块，其余命令回填或直接发送。
- `AgentLoop` 每次 `run` 使用启动时的 provider 快照；`updateProvider` / `updateModelConfig` 只影响切换之后启动的新 run，进行中的流式回复不受影响。

## Goals / Non-Goals

**Goals:**
- 对话输入 `/` 的菜单中出现「切换模型」命令；直接输入 `/model` 回车同样触发。
- 选中后弹出模型选择列表（QuickPick），仅列出已启用模型并标注当前默认项；选择后立即持久化切换。
- 切换后新发送的消息使用新模型；进行中的流不中断；对话面板头部模型名同步更新。
- 全程不将 API Key 下发到 Webview。

**Non-Goals:**
- 会话级模型绑定（每个会话独立模型、历史消息归属模型）——本次保持「全局默认模型」语义。
- `/model <模型名>` 参数解析、模型搜索排序、临时（不持久化）切换。
- 在 Webview 内自绘模型选择 UI（采用 VSCode 原生 QuickPick）。

## Decisions

### 1. 切换语义：全局默认模型（复用 `setDefaultModel` + `applyModelConfig`）
`/model` 切换的是「当前默认模型」，与设置页「设为默认」行为一致，持久化写回 `models.json`。

- **理由**：现状模型选择就是「默认模型」单点语义，会话不绑定模型；复用既有闭环（存储层已实现、扩展装配已注入），改动面最小且语义一致。
- **替代方案（放弃）**：会话级模型绑定——需改动 `SessionMeta` / `MessageStore` / `AgentLoop.run` 签名 / 历史加载与前端展示，涉及持久化结构与 UI 大改，收益超出本次范围，留待后续迭代。

### 2. 选择交互：VSCode 原生 QuickPick
扩展侧 `vscode.window.showQuickPick` 列出已启用模型（`${model}（${provider}）`，默认项带「默认」标注）。

- **理由**：零前端改动、原生键盘导航与搜索、与插件既有交互（打开文件对话框）一致。
- **替代方案（放弃）**：Webview 内自定义选择器——需新增协议消息、reducer 状态与 UI 组件，收益低。

### 3. 触发链路：新 action 值 `switchModel` + 新 `switchModel` 消息
- `SlashCommand.action` 联合类型（扩展侧与 webview 协议侧同步）新增 `'switchModel'`；
- `BASIC_COMMANDS` 新增 `/model` 项（`command: 'model'`，`action: 'switchModel'`）；
- `MessageInput.selectSlashCommand` 的 action 分发新增分支：`post({ command: 'switchModel' })`；
- 宿主 `_handleMessage` 新增 `case 'switchModel'`：读模型列表 → QuickPick → `modelStore.setDefaultModel(id)` → `onModelConfigSaved(config)`（即 `applyModelConfig`，内部已 `refreshModelInfo`）。

- **理由**：与 `newSession` / `stopStream` 的「特殊动作」模式完全一致；`/model` 作为命令文本进入会话，避免把控制指令发给 LLM。
- **替代方案（放弃）**：把 `/model` 当普通文本发送由 LLM 解释——行为不可控、浪费 token。

### 4. 生效时机：沿用 AgentLoop provider 快照语义
切换只影响之后启动的 run，进行中的流保持原 provider 直至结束。

- **理由**：零改动、与设置页保存模型配置后的行为一致；`AgentLoop` 已明确「进行中的 run 不受影响」。
- **风险**：用户在流式回复进行中切换模型，本次回复仍是旧模型——属预期行为，头部模型名实时更新已提供反馈。

### 5. `src/extension.ts` 零改动
`modelStore`、`applyModelConfig`（作为 `onModelConfigSaved`）、`refreshModelInfo` 均已装配注入到 `ChatViewProvider`，`/model` 的全部逻辑落在 `chatPanel.ts` 内。

## Risks / Trade-offs

- [QuickPick 无可用模型（未配置或全部禁用）] → 弹提示引导打开设置页，不执行切换。
- [全局默认语义：切换后旧会话继续对话也用新模型] → 与设置页「设为默认」一致；如需会话级模型在后续迭代引入。
- [用户手输 `/model` 直接发送] → 会作为普通文本发给 LLM（与手输 `/new` 现状一致），可接受；菜单选中路径不受影响。
- [切换与流式回复并发] → `setDefaultModel` 写文件 + `applyModelConfig` 重建 provider；AgentLoop 快照保证进行中的 run 安全，不中断。
- [QuickPick 展示名冲突（同名不同 Provider）] → 展示项同时含 Provider 与模型名，可区分。

## Migration Plan

- 纯新增命令与协议消息，无数据迁移、无破坏性变更；随插件发布自动生效。
- 回滚：移除 `/model` 命令项与 `switchModel` 处理即可，不影响既有模型配置。
