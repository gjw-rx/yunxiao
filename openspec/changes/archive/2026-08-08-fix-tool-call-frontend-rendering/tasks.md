## 1. AgentLoop 发出 tool_call 事件

- [ ] 1.1 在 `src/agent/agentLoop.ts` 第 154-159 行收到 `toolCall` LLMEvent 时，除存入 `pendingToolCalls` 外，emit `tool_call` 事件，payload 为 `{ call_id: event.id, tool: event.name, args: parsed(event.arguments) }`
- [ ] 1.2 验证：运行 agentLoop 单测，确认 `tool_call` 事件被发出

## 2. ChatPanel _forwardEvent 转发 tool_call 和 tool_result

- [ ] 2.1 在 `src/chatPanel.ts` `_forwardEvent` switch 中增加 `case 'tool_call'`，postMessage `{ command: 'toolCall', ...payload }`
- [ ] 2.2 在 `_forwardEvent` switch 中增加 `case 'tool_result'`，postMessage `{ command: 'toolResult', ...payload }`
- [ ] 2.3 验证：确认事件不再落入 default 被丢弃

## 3. Webview 前端处理 toolCall 命令

- [ ] 3.1 在 `src/chatPanel.ts` webview message handler 中增加 `case 'toolCall'`，调用 `showToolState(msg.tool, 'pending', undefined, msg.call_id, msg.args)`
- [ ] 3.2 确认 `getStatusIcon` 已有 pending 分支（返回时钟图标），无需新增
- [ ] 3.3 验证：pending 卡片正确创建，后续 toolState running 更新同一卡片而非创建新卡片

## 4. HistoryEntry 扩展与历史加载

- [ ] 4.1 在 `src/core/localSessionManager.ts` `HistoryEntry` 接口增加 `toolCalls?: Array<{ id: string; name: string; arguments: string }>` 和 `toolCallId?: string`
- [ ] 4.2 修改 `loadHistory` 不再过滤 `tool` 角色消息，全部映射返回
- [ ] 4.3 在 `src/chatPanel.ts` `historyLoaded` 处理中，对 `tool` 角色消息调用 `showToolState` 渲染工具结果步骤；对含 `toolCalls` 的 assistant 消息渲染工具 pending 步骤
- [ ] 4.4 验证：切换会话后历史恢复时工具步骤可见

## 5. code.edit diffResult 命令接通

- [ ] 5.1 在 `src/chatPanel.ts` `_forwardEvent` 的 `tool_state_change` case 中，当 `tool === 'code.edit'` 且 `state === 'success'` 且 `output` 含 `diff` 时，额外 postMessage `diffResult` 命令
- [ ] 5.2 验证 `showDiffCard` 前端渲染代码已存在，无需修改
- [ ] 5.3 验证：code.edit 成功后 diff 卡片出现在 trace 中

## 6. 测试与验证

- [ ] 6.1 运行全部现有单测确认无回归
- [ ] 6.2 手动测试：输入"看下当前git缓存区"，确认工具调用过程（pending → running → success）在 trace 中可见
- [ ] 6.3 手动测试：切换会话再切回，确认历史工具步骤恢复显示
- [ ] 6.4 手动测试：code.edit 编辑文件后 diff 卡片显示
