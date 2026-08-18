## 1. Plan 状态契约与持久化

- [x] 1.1 先为 Plan 状态规范化、旧索引兼容、非法值回退和会话隔离补充存储层单元测试
- [x] 1.2 定义 `normal`、`planning`、`review`、`executing` 阶段及草案标记的只读类型契约，并为所有函数和字段补齐中文 JSDoc
- [x] 1.3 扩展 `SessionFileStore` 的会话索引读写，原子持久化可选 Plan 状态且不复制 Todo 列表
- [x] 1.4 实现会话级 Plan 状态服务，封装合法转换、当前状态读取、坏值回退、类型化事件与关键中文日志
- [x] 1.5 运行新增存储与状态服务测试，确认旧会话按 `normal` 加载且不同会话互不影响

## 2. 只读工具安全边界

- [x] 2.1 先补充 AgentLoop 工具暴露测试，覆盖 planning/review 仅保留 `read`、`todo_write` 可用、terminal/write/execute/destructive 被过滤及 normal/executing 完整工具集
- [x] 2.2 先补充 ToolRouter 兜底测试，验证禁止调用在 Hook、审批和工具 execute 前返回 `cancelled`，并验证明确只读与未声明只读的 MCP 工具差异
- [x] 2.3 在统一 Plan 状态服务中实现按会话和 `ToolSchema.permissions` 判定工具可用性的单一策略
- [x] 2.4 在 AgentLoop 物化工具定义前应用策略，并确保 token 估算、自动压缩和实际 LLM 请求使用同一过滤后工具集
- [x] 2.5 在 ToolRouter 查找工具后、参数 Hook 和审批前应用同一策略，记录 sessionId、阶段、工具名与 callId 且不记录敏感参数
- [x] 2.6 运行 AgentLoop 与 ToolRouter 定向测试，确认 Plan 模式的模型可见边界和执行边界一致

## 3. 规划、审阅与执行生命周期

- [x] 3.1 先补充规划上下文测试，验证 planning 指令临时注入、不写入历史、抑制“继续执行活跃任务”恢复提示且普通模式不受影响
- [x] 3.2 先补充状态转换测试，覆盖仅当前 run 成功的非空 `todo_write` 可进入 review，Markdown/旧快照/空写入/失败 run 均不可触发审阅
- [x] 3.3 实现 Plan 规划提示和 AgentLoop run 级 `todo_write` 成功信号跟踪，在 run 正常结束后原子进入 review
- [x] 3.4 扩展 LocalSessionManager，提供进入、继续规划、退出和确认执行接口，并校验 Agent 空闲、当前阶段、会话 ID 与活跃 Todo 前置条件
- [x] 3.5 为确认执行增加同会话隐藏执行指令入口：先持久化 executing，再启动一次且不渲染为普通用户消息，不创建新会话
- [x] 3.6 将 executing 与 Todo 快照联动：仍有活跃任务时保留执行态，全部 completed/cancelled 时回到 normal，取消或失败时不自动重放
- [x] 3.7 实现退出时的草案清理和 `todo_state_change` 同步，保证没有创建本轮草案时不误删旧 Todo 快照
- [x] 3.8 运行生命周期定向测试，覆盖正常规划、细化、放弃、执行、完成、取消、失败、重复操作和过期会话操作

## 4. Webview 与斜杠入口

- [x] 4.1 先补充 ChatPanel 消息协议测试，覆盖 Plan 状态加载、当前会话事件过滤、模式动作校验和历史刷新时的状态回推
- [x] 4.2 定义 `plan_mode_change` EventBus payload 与 Host-to-Webview 类型，并在 extension 装配状态服务到 AgentLoop、ToolRouter、LocalSessionManager 和 ChatPanel
- [x] 4.3 在聊天输入区新增 Plan 模式入口和阶段状态，运行期间禁用切换，并保持现有布局与样式约定
- [x] 4.4 在现有 Todo 面板的 review 状态新增“执行计划”“继续规划”“退出规划”操作，防抖并携带当前 sessionId
- [x] 4.5 将 `/plan` 注册为基础功能宿主动作，使斜杠菜单和直接选择均调用模式切换且不发送聊天消息
- [x] 4.6 在 Webview 初始化、切换会话和加载历史时回推对应 Plan 状态，忽略非当前会话的实时事件
- [x] 4.7 运行 ChatPanel、斜杠菜单和 Todo 面板定向测试，验证三种审阅操作与会话隔离

## 5. 回归验证

- [x] 5.1 运行 Todo、上下文压缩、工具审批、MCP 权限映射、会话存储和 AgentLoop 既有回归测试，确认 Plan 功能未改变原有行为
- [x] 5.2 运行 `npm test`，修复全部失败并保留完整测试输出
- [ ] 5.3 运行 `npm run compile`，确保 TypeScript strict、ESLint 与 esbuild 全部通过且无警告
- [ ] 5.4 人工验证一次完整流程：进入 Plan、只读调研、Todo 计划、继续细化、确认执行、审批写入、进度完成、切换会话与重启恢复，并核对关键日志
