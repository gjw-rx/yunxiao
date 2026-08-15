## 1. 会话任务状态持久化

- [x] 1.1 在会话存储类型中定义任务项、状态、快照和统计契约，并为旧 `index.json` 的缺失或损坏任务字段提供空状态兼容。
- [x] 1.2 扩展 `SessionFileStore`，以现有串行原子索引写入路径读取、写入和删除 sessionId 对应的任务快照。
- [x] 1.3 新建会话级 TodoStore，落实任务列表全量替换、顺序保留、状态/ID/单一进行中校验，以及任务数量与内容长度上限。
- [x] 1.4 为 TodoStore 和 SessionFileStore 增加持久化恢复、会话隔离、旧索引兼容及删除清理测试。

## 2. 本地 Todo 工具与运行时事件

- [x] 2.1 实现 `TodoWriteTool`，声明 `todo_write` JSON Schema、模型使用指引、无审批权限、非并行执行和结构化完整快照返回。
- [x] 2.2 在工具成功写入后发出类型化 `todo_state_change` 事件，并在关键写入、校验失败和恢复路径记录中文定位日志。
- [x] 2.3 在扩展激活时装配 TodoStore、TodoWriteTool 与 EventBus 依赖，并注册工具。
- [x] 2.4 为工具契约、无效写入不改状态、全量替换、事件载荷及工具注册添加测试。

## 3. AgentLoop 活跃任务上下文

- [x] 3.1 在每个 AgentLoop 请求组装时读取当前会话快照，并以临时 system 消息注入仅含 pending/in_progress 的紧凑任务上下文。
- [x] 3.2 确保临时任务上下文不写入 MessageStore，且参与请求 token 估算、自动压缩阈值与溢出恢复的请求构建。
- [x] 3.3 为工具更新后的下一请求、压缩边界后的恢复、完成/取消任务排除和 token 估算添加 AgentLoop 测试。

## 4. Webview 任务进度面板

- [x] 4.1 扩展 EventBus、ChatPanel 和 Host-to-Webview 协议，转发实时 todoState，并在会话历史加载/切换时下发持久化快照。
- [x] 4.2 扩展 Webview reducer 和 host-action 映射，维护当前会话单一任务快照，并在会话删除或切换时正确复位。
- [x] 4.3 新建只读可折叠 TodoPanel，展示完成/总数和四种状态，并将其置于消息列表与输入框之间；完成状态不自动隐藏。
- [x] 4.4 为协议映射、实时更新、历史会话恢复、折叠交互和“更新不新增聊天条目”添加 Webview 测试。

## 5. 验证

- [x] 5.1 运行 Todo、AgentLoop、会话存储和 Webview 相关测试，修复与规格不符的行为。
- [x] 5.2 运行 `npm run compile`，确认严格类型检查、lint 和扩展打包通过。
