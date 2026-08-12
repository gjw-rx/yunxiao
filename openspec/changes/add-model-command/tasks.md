## 1. 斜杠命令定义与协议扩展

- [ ] 1.1 `src/chat/slashCommands.ts`：`SlashCommand.action` 联合类型新增 `'switchModel'`；`BASIC_COMMANDS` 新增 `/model` 命令项（id `basic.switch-model`、command `model`、label `切换模型`、description `切换当前对话使用的模型`、action `switchModel`）
- [ ] 1.2 `src/webview-ui/protocol.ts`：webview 侧 `SlashCommand.action` 同步新增 `'switchModel'`；新增 `SwitchModelMessage`（command `switchModel`）并并入 `WebviewToHostMessage` 联合类型

## 2. Webview 选中分发

- [ ] 2.1 `src/webview-ui/components/chat/MessageInput.tsx`：`selectSlashCommand` 的 action 分发新增 `switchModel` 分支，选中后 `post({ command: 'switchModel' })` 且不发送消息、不回填文本

## 3. 宿主侧切换处理

- [ ] 3.1 `src/chatPanel.ts`：`_handleMessage` 新增 `case 'switchModel'`——读取 `modelStore.getSettingsView()` 过滤已启用模型 → `vscode.window.showQuickPick` 选择（标注当前默认项）→ `modelStore.setDefaultModel(id)` → 调用 `onModelConfigSaved(config)`（内部重建 Provider 并刷新 modelInfo）→ 打印切换日志
- [ ] 3.2 无可用模型分支：提示用户先配置模型（引导打开设置页），不执行切换

## 4. 测试与验证

- [ ] 4.1 `src/test/chat/slashCommands.test.ts`：补充断言——基础功能分组包含 `/model` 命令，`command === 'model'` 且 `action === 'switchModel'`
- [ ] 4.2 chatPanel `switchModel` 处理测试：mock `modelStore`（`getSettingsView` / `setDefaultModel`）与 `onModelConfigSaved`，验证选择后切换与回调、无可用模型提示分支
- [ ] 4.3 运行 `npm run compile`（类型检查 + lint + 打包）与聚焦测试，确保全部通过

验证标准：`npm run compile` 通过；`slashCommands` 与 chatPanel 相关测试通过；无回归。
