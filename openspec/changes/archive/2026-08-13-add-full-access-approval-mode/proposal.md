## Why

频繁的工具审批会打断连续开发，但用户仍需要对删除类操作保留最后确认。输入框目前只有文件引用入口，缺少一个可见、可切换的审批策略入口，无法在“逐次请求批准”和“非删除操作自动批准”之间快速切换。

## What Changes

- 在对话输入框底栏的“+”文件引用按钮右侧新增审批模式按钮与菜单，提供“请求批准”和“完全访问”两个互斥选项，并清晰说明完全访问的影响。
- 将所选审批模式作为当前工作区的本地设置保存；Webview 重建、重新打开对话面板或创建新会话后恢复该模式，用户可随时切回“请求批准”。
- 在“完全访问”模式下，审批网关自动放行所有原本需要普通审批的非删除工具调用，不显示审批卡片或 VS Code 审批提示。
- 删除类工具调用继续执行现有的人工确认流程；终端中的删除命令也不得因完全访问模式而自动放行。
- 完全访问只改变审批决策，不绕过路径边界、危险命令拦截、安全审计、结果脱敏或输出截断等独立安全控制。

## Capabilities

### New Capabilities

- `full-access-approval-mode`: 提供对话输入区的审批模式选择、状态展示与工作区级持久化，并定义完全访问模式的用户可见语义。

### Modified Capabilities

- `approval-gateway`: 审批网关根据已保存的模式，对非删除操作应用自动批准，同时保持删除操作的人工确认。
- `terminal-tools`: 终端工具识别删除命令，使其在完全访问模式下仍进入人工确认而非自动执行。

## Impact

- 前端：`src/webview-ui/components/chat/MessageInput.tsx`、Webview 协议、状态管理和 `chat.css`。
- 宿主与核心：`src/chatPanel.ts`、`src/core/approvalGateway.ts`，以及其单元测试。
- 终端：`src/tools/terminal/terminalExec.ts`、`shellWhitelist.ts` 及对应测试。
- 现有审批与终端 OpenSpec 规格将新增 delta；不新增外部依赖或云端 API。
