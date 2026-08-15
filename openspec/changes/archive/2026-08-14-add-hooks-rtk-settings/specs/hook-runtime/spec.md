## ADDED Requirements

### Requirement: 四类基础 Hook 事件
系统 SHALL 提供异步 Hooks 运行时，并仅提供 `session_start`、`pre_tool_call`、`post_tool_call` 和 `session_end` 四类基础事件。`session_start` SHALL 在每次 AgentLoop 运行开始时触发，`session_end` SHALL 在该次运行以成功、错误或取消结束时触发；两者的载荷 SHALL 包含会话 ID、运行 ID 与工作区元数据，但不得包含完整会话历史。`pre_tool_call` SHALL 在本地工具初始参数校验通过后、执行前触发；`post_tool_call` SHALL 在工具结果完成共同结果治理后触发。

#### Scenario: 一次正常运行产生开始与结束事件
- **WHEN** AgentLoop 成功完成一次会话运行且未调用任何工具
- **THEN** 系统按顺序派发一次 `session_start` 和一次 `session_end`，且不向 Handler 提供完整对话历史

#### Scenario: 工具调用产生前后事件
- **WHEN** 已校验的本地工具调用执行并返回受治理的结果
- **THEN** 系统在执行前派发一次 `pre_tool_call`，在结果治理后派发一次 `post_tool_call`

### Requirement: Hook 执行顺序、超时与故障隔离
同一事件的 Hook SHALL 按稳定优先级串行运行，且每个 Hook SHALL 有有界超时。普通观察 Hook 的异常、超时或无效返回 SHALL 被记录并隔离，且不得中断 AgentLoop、工具执行或其他 Hook。只有 `pre_tool_call` Handler 明确返回阻断决定时，系统 SHALL 取消工具调用并返回可读原因。

#### Scenario: 一个观察 Hook 超时
- **WHEN** 一个 `post_tool_call` Hook 超过其执行超时
- **THEN** 系统记录包含 Hook ID、事件名、会话 ID 和耗时的中文日志，继续执行剩余 Hook，并保留原工具结果

#### Scenario: Pre-tool Hook 明确阻断调用
- **WHEN** 一个 `pre_tool_call` Guard Hook 返回阻断决定及原因
- **THEN** 系统不执行该工具，返回 cancelled 结果，并不运行该调用的后续转换或审批步骤

### Requirement: 受信任的参数转换契约
`pre_tool_call` SHALL 支持受信任的 Transform Hook 返回替换后的工具参数。Transform Hook SHALL 仅能替换 `args`，不得修改工具名、调用 ID、权限、注册来源或工作区范围。Router SHALL 在使用替换后的参数前重新执行既有 schema 与手写参数校验；转换异常、超时、无效参数或未返回替换结果 SHALL 保留原始参数。

#### Scenario: 合法转换后重新校验
- **WHEN** 受信任 Transform Hook 为已校验工具返回新的 `args`
- **THEN** Router 对新参数重新校验，校验通过后才将其作为最终调用继续处理

#### Scenario: 无效转换不改变调用
- **WHEN** Transform Hook 返回不符合工具 schema 的参数
- **THEN** 系统记录该 Hook 的失败并继续使用原始已校验参数，不执行无效参数

### Requirement: Hooks 配置快照与内置注册边界
系统 SHALL 使用插件私有用户级持久化状态保存 Hooks 总开关、已注册内置 Hook 的启用状态及其非敏感配置。第一版 SHALL 只加载扩展内置的受信任 Hook，且不得从工作区、网络、任意脚本路径或 npm 包加载第三方 Hook。Host SHALL 向设置 Webview 返回不含秘密的配置与运行状态快照。

#### Scenario: 第一次启动使用安全默认值
- **WHEN** 扩展首次启动且不存在 Hooks 配置
- **THEN** 系统创建 Hooks 运行时默认配置，且 RTK 集成保持禁用

#### Scenario: Webview 请求 Hooks 快照
- **WHEN** 设置页请求 Hooks 配置
- **THEN** Host 返回总开关、内置 Hook 状态和非敏感运行状态，且不返回环境变量或命令输出中的秘密
