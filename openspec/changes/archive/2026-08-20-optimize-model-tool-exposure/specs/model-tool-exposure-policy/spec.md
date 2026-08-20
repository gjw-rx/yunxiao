## ADDED Requirements

### Requirement: 本地模型工具采用 OpenCode 职责型集合

普通模式和 executing 阶段 SHALL 直接向模型暴露且仅暴露以下 13 个本地职责型工具：`bash`、`read`、`glob`、`grep`、`edit`、`write`、`apply_patch`、`task`、`webfetch`、`websearch`、`todowrite`、`skill`、`question`。现有本地专用工具 SHALL 继续保留在完整 Registry 中作为执行实现，但不再以独立本地 schema 发送给模型。未显式加入职责映射的新本地工具 SHALL 默认不直接暴露。

#### Scenario: 普通模式使用固定本地集合
- **WHEN** 普通模式的 Registry 包含现有 21 个本地工具
- **THEN** 模型请求包含上述 13 个本地职责型工具
- **AND** 不包含独立的 `fs_*`、`code_*`、`git_*` 或其他本地专用 schema

#### Scenario: executing 阶段恢复完整职责集合
- **WHEN** Plan 从 reviewing 进入 executing 阶段
- **THEN** 本地模型工具集合恢复为 13 个职责型工具
- **AND** 底层 Registry 工具名仍只作为内部路由名使用

#### Scenario: 未映射本地工具不会自动膨胀
- **WHEN** 新本地工具注册成功但没有职责型映射
- **THEN** 该工具保留在 Registry 中
- **AND** 本次和后续模型请求都不会自动增加独立本地 schema

### Requirement: 职责型工具保持清晰的能力边界

系统 SHALL 按以下职责提供结构化参数和安全边界：`bash` 承载构建、测试、Git、包管理和组合命令；`read` 同时读取文件与目录；`glob` 按路径模式查找文件；`grep` 搜索内容；`edit`、`write`、`apply_patch` 分别执行结构化局部修改、完整写入和统一 patch；`task` 委派子 Agent；`webfetch` 和 `websearch` 处理外部信息；`todowrite` 更新任务状态；`skill` 加载技能；`question` 向用户提问。所有职责型工具 SHALL 通过 ToolRouter 执行。

#### Scenario: read 可以读取文件和目录
- **WHEN** 模型使用 `read` 请求文件或目录路径
- **THEN** 系统分别返回文件内容或目录条目
- **AND** 两种操作都经过现有路径守卫和结果治理

#### Scenario: bash 执行组合命令
- **WHEN** 模型使用 `bash` 请求构建、测试、Git、包管理或组合命令
- **THEN** 系统交给受白名单、工作区、超时和审批约束的 terminal 执行链
- **AND** 不因为工具名称为 bash 而绕过安全审计

#### Scenario: 结构化修改工具分工
- **WHEN** 模型选择 `edit`、`write` 或 `apply_patch` 修改工作区文件
- **THEN** 系统按对应参数契约执行并生成既有 diff/审批信息
- **AND** 路径守卫、审批和执行台账保持生效

### Requirement: 工具快照在单次 Agent run 内稳定

系统 SHALL 在每次 Agent run 开始时捕获一次本地 Registry 和 ready MCP 工具快照，并在该 run 的所有 step 中复用不可变的本地职责型 schema 与 MCP schema 集合。schema token 估算、上下文压缩、模型请求和调用范围校验 SHALL 引用同一快照；注册、配置或 MCP 状态变化 SHALL 从下一个 run 起生效。

#### Scenario: 中途注册工具不改变当前请求集合
- **WHEN** 一个 run 执行多个模型 step 且中途注册新的本地工具
- **THEN** 当前 run 后续请求仍使用原有 13 个本地职责型工具和原 MCP 快照
- **AND** 新工具只在下一个 run 重新计算

#### Scenario: 底层 MCP 下线不改变已发送 schema
- **WHEN** ready MCP 工具已进入当前 run 请求后 Server 在执行前下线
- **THEN** 当前 run 的模型 schema 保持不变
- **AND** 执行路径返回明确 unavailable 结果而不静默替换工具

### Requirement: 职责型 facade 不绕过统一执行治理

职责型工具 SHALL 只负责模型协议名称、参数适配和底层 ToolCall 构造；实际调用 SHALL 继续经过 ToolRouter 的 lookup、Plan 权限、Hook、JSON Schema 校验、安全审计、审批、执行台账和结果治理。Facade MUST NOT 直接调用 BaseTool.execute、MCP Manager 或终端进程。

#### Scenario: facade 映射到现有本地实现
- **WHEN** 模型调用 `read`、`edit` 或 `todowrite`
- **THEN** facade 将其映射到底层对应 ToolCall 并交由 ToolRouter
- **AND** 底层工具的权限、审批和结构化错误语义保持不变

#### Scenario: 未知职责工具调用被拒绝
- **WHEN** 模型提交不在当前本地职责集合中的工具名
- **THEN** AgentLoop 返回工具不在当前暴露范围的结构化错误
- **AND** 不直接按名称猜测或调用 Registry 中的其他工具

### Requirement: 暴露统计可观测且不泄露敏感数据

系统 SHALL 记录每次快照的 session/run、Plan 阶段、本地注册数、本地暴露数、MCP 暴露数和 schema token 估算。调用日志可以记录职责名、底层工具名、来源和耗时，但 MUST NOT 记录完整参数、完整 schema、工具结果或密钥。

#### Scenario: 创建快照输出本地与 MCP 计数
- **WHEN** AgentLoop 创建运行级工具快照
- **THEN** 日志包含本地职责工具计数和 ready MCP 工具计数
- **AND** 日志不包含敏感参数和完整 schema

