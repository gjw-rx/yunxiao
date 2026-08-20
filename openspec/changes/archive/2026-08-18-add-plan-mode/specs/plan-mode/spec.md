## ADDED Requirements

### Requirement: 用户可按会话进入和退出 Plan 模式
系统 SHALL 为每个会话维护独立的 `normal`、`planning`、`review`、`executing` 阶段。用户 SHALL 可通过聊天输入区的模式入口或内置 `/plan` 动作从空闲的 `normal` 会话进入 `planning`；`/plan` MUST NOT 作为聊天消息发送给模型。Agent 正在运行或会话存在活跃 Todo 时，系统 MUST 拒绝开始新的 Plan 流程并说明原因。

#### Scenario: 从输入区进入 Plan 模式
- **WHEN** 当前会话处于 `normal`、Agent 空闲且不存在 `pending` 或 `in_progress` Todo，用户选择 Plan 模式
- **THEN** 系统将该会话切换为 `planning`，更新 Webview 模式状态，且不向模型发送消息

#### Scenario: 通过斜杠动作进入 Plan 模式
- **WHEN** 用户从内置斜杠菜单选择 `/plan`
- **THEN** 系统调用与模式入口相同的宿主动作，输入框不残留 `/plan`，聊天历史不新增 `/plan` 用户消息

#### Scenario: 运行中拒绝切换模式
- **WHEN** 当前会话的 Agent 正在生成或执行工具，用户尝试进入或退出 Plan 模式
- **THEN** 系统保持原阶段并向用户显示当前运行结束或停止后再切换的提示

#### Scenario: 活跃任务阻止新计划覆盖
- **WHEN** `normal` 会话仍有 `pending` 或 `in_progress` Todo，用户尝试开始新的 Plan 流程
- **THEN** 系统拒绝切换并保留原任务快照

### Requirement: 规划阶段使用结构化 Todo 提交计划
系统 SHALL 在 `planning` 阶段向模型加入不持久化的规划指令，要求模型仅调研和澄清需求、禁止实施修改，并使用现有 `todo_write` 提交完整有序的计划。只有当前 Agent run 成功执行了非空 `todo_write` 且正常结束，系统 SHALL 将会话切换为 `review`；旧 Todo 快照、助手 Markdown 列表或空写入 MUST NOT 单独触发 `review`。

#### Scenario: 模型成功提交计划
- **WHEN** 模型在规划 run 中先使用只读工具调研，再成功调用 `todo_write` 写入非空任务列表，且该 run 正常结束
- **THEN** 系统保留该 Todo 快照，将阶段切换为 `review`，并在现有 Todo 面板显示计划

#### Scenario: 未提交结构化计划
- **WHEN** 规划 run 正常结束，但当前 run 未成功调用非空 `todo_write`
- **THEN** 系统保持 `planning`，不展示“执行计划”操作，并允许用户继续补充需求

#### Scenario: Markdown 计划不作为状态依据
- **WHEN** 助手回复包含 `Plan:` 或编号列表，但未成功调用非空 `todo_write`
- **THEN** 系统不解析该文本为计划，也不进入 `review`

#### Scenario: 规划 run 失败
- **WHEN** 模型请求失败或用户取消规划 run
- **THEN** 系统保持 `planning`，不自动开始执行，已成功持久化的 Todo 快照保持可见

### Requirement: Plan 模式强制只读工具边界
在 `planning` 或 `review` 阶段，系统 SHALL 仅向模型暴露 `permissions === 'read'` 的工具定义。系统 MUST 在本地工具路由入口使用相同会话策略再次校验调用，并 MUST 在 Hook、审批或实际执行之前以结构化取消结果拒绝所有非允许工具。`todo_write` SHALL 因其会话元数据性质和现有 `read` 权限继续可用；`terminal_exec`、写入、执行和破坏性工具 MUST NOT 可用。

#### Scenario: 模型仅看到只读工具与 Todo
- **WHEN** `planning` 会话构建 LLM 请求
- **THEN** 请求工具列表只包含本地只读工具、明确声明只读的 MCP 工具及 `todo_write`，不包含 `terminal_exec` 或任何 `write`、`execute`、`destructive` 工具

#### Scenario: 隐藏工具调用被路由兜底拒绝
- **WHEN** 模型在 `planning` 阶段仍返回一个已注册但不允许的写入或执行工具调用
- **THEN** ToolRouter 在 Hook、审批和执行之前返回 `cancelled` 结果，目标工具没有副作用

#### Scenario: 未声明只读的 MCP 工具被排除
- **WHEN** MCP 工具没有 `readOnlyHint: true`，其权限按现有规则映射为 `execute`
- **THEN** 该工具在 `planning` 和 `review` 阶段既不暴露给模型也不能被路由执行

#### Scenario: Plan 模式允许更新任务草案
- **WHEN** 模型在 `planning` 阶段调用 `todo_write` 更新完整任务列表
- **THEN** 系统按既有 Todo 校验和持久化规则执行调用，且不触发写入工具审批

### Requirement: 计划执行必须经过用户确认
进入 `review` 后，系统 SHALL 停止自动 Agent 调用，并 SHALL 在 Todo 面板提供“执行计划”“继续规划”“退出规划”操作。只有“执行计划”可将阶段切换为 `executing`；“继续规划” SHALL 恢复 `planning` 并保留当前草案；“退出规划” SHALL 返回 `normal`，若本轮已创建草案则清空该草案。所有操作 MUST 校验当前会话、阶段与运行状态，重复或过期操作 MUST NOT 触发执行。

#### Scenario: 审阅阶段不会自动实施
- **WHEN** 规划 run 生成有效计划并进入 `review`
- **THEN** 系统显示三种后续操作且不自动调用任何修改工具或启动执行 turn

#### Scenario: 用户继续细化计划
- **WHEN** 用户在 `review` 选择“继续规划”
- **THEN** 系统切换为 `planning`，保留当前 Todo 草案并聚焦输入区，等待用户提交补充要求

#### Scenario: 用户退出并放弃草案
- **WHEN** 用户在 `planning` 或 `review` 退出，且本轮已成功创建 Todo 草案
- **THEN** 系统切换为 `normal`、清空本轮草案并同步更新 Todo 面板

#### Scenario: 过期执行操作无副作用
- **WHEN** Webview 对已切换会话或不再处于 `review` 的会话发送“执行计划”操作
- **THEN** 宿主拒绝该操作，不改变任何会话状态且不启动 Agent run

### Requirement: 确认后在同一会话执行并跟踪 Todo
用户确认执行时，系统 SHALL 先持久化 `executing`，恢复该会话的完整工具集，再在同一会话启动一条不在聊天区展示的执行指令。执行阶段 SHALL 沿用既有 Todo 快照、任务上下文、审批网关和 `todo_write` 状态更新；系统 MUST NOT 创建新会话或复制计划。当快照不再包含 `pending` 或 `in_progress` 项时，系统 SHALL 自动返回 `normal`。

#### Scenario: 确认后开始执行第一项未完成任务
- **WHEN** `review` 会话具有待办计划且用户选择“执行计划”
- **THEN** 系统切换为 `executing`、恢复完整工具集，并在同一会话触发执行 turn 从第一项未完成任务开始

#### Scenario: 执行仍遵循原审批规则
- **WHEN** 执行计划需要调用 `write`、`execute` 或 `destructive` 权限工具
- **THEN** 调用按既有 ApprovalGateway 规则请求或复用审批，Plan 功能不绕过审批

#### Scenario: 结构化状态驱动完成
- **WHEN** 模型通过 `todo_write` 将所有任务更新为 `completed` 或 `cancelled`
- **THEN** 系统将会话阶段切换为 `normal`，保留既有 Todo 最终快照展示，且不依赖助手文本中的完成标记

#### Scenario: 执行失败保留进度
- **WHEN** `executing` 阶段的 Agent run 失败或被用户取消，且仍有活跃 Todo
- **THEN** 系统保持 `executing` 和当前 Todo 快照，不自动重放任何工具调用，用户可在同一会话继续

### Requirement: Plan 状态可持久化并按会话恢复
系统 SHALL 将 Plan 阶段和必要的草案标记作为可选会话状态原子持久化，并 SHALL 与 Todo 快照保持会话隔离。Webview 重建、会话切换或扩展重启后，系统 SHALL 恢复对应阶段、工具策略和可用操作；缺失、损坏或非法状态 MUST 回退为 `normal` 且 MUST NOT 阻止消息历史加载。

#### Scenario: 重启后恢复规划审阅
- **WHEN** 会话在 `review` 阶段关闭扩展，随后重启并打开该会话
- **THEN** 系统恢复 `review`、只读工具策略、Todo 草案与三种审阅操作，且不自动执行计划

#### Scenario: 重启后恢复执行进度
- **WHEN** 会话在 `executing` 阶段仍有活跃 Todo，随后扩展重启
- **THEN** 系统恢复 `executing` 和完整工具策略并显示现有进度，但不自动重放上次执行 turn

#### Scenario: 会话之间模式隔离
- **WHEN** 会话 A 处于 `planning`，用户切换到处于 `normal` 的会话 B
- **THEN** Webview 和工具策略使用会话 B 的 `normal` 状态，会话 A 保持 `planning`

#### Scenario: 旧会话兼容
- **WHEN** 加载不含 Plan 状态字段的旧会话索引
- **THEN** 系统按 `normal` 加载会话和历史，不报错且不改变 Todo 快照

### Requirement: Plan 关键状态通过类型化事件和日志可观测
系统 SHALL 为 Plan 状态变化定义类型化 EventBus 与 Host-to-Webview 消息。进入、退出、审阅、确认执行、恢复、拒绝工具与异常分支 MUST 通过统一 logger 记录会话 ID、阶段和必要的工具信息，且 Plan 状态更新 MUST NOT 渲染为普通聊天消息。

#### Scenario: 当前会话实时更新模式 UI
- **WHEN** 当前会话的 Plan 阶段发生变化
- **THEN** Webview 无需重载聊天历史即可更新模式入口、Todo 面板操作和状态提示

#### Scenario: 非当前会话事件不污染界面
- **WHEN** 后台会话 A 发出 Plan 状态事件，而 Webview 当前展示会话 B
- **THEN** Webview 忽略该实时渲染事件，会话 B 的模式 UI 保持不变

#### Scenario: 被拒绝工具留有定位日志
- **WHEN** ToolRouter 因 Plan 策略拒绝工具调用
- **THEN** 日志包含会话 ID、当前阶段、工具名和 call ID，且不记录敏感参数内容
