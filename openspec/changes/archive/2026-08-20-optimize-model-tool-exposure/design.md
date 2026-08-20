## Context

当前 `ToolRegistry` 同时承担完整执行目录和模型可见工具列表两种职责。普通模式会把 21 个本地工具以及所有 ready MCP 工具发送给模型。本变更只收敛本地工具的模型协议，把多个专用实现归并到 OpenCode 风格的职责型 facade；MCP 维持现状，ready 工具仍全部直接进入模型请求。

## Goals / Non-Goals

**Goals:**

- 将本地完整执行目录与本地模型可见职责型工具集合解耦。
- 普通/执行阶段稳定暴露 13 个 OpenCode 风格本地工具。
- 保持所有 enabled 且 ready MCP Function Tool 的完整 schema 直接暴露。
- 保证同一次 Agent run 的本地与 MCP 工具快照稳定，并让 schema 估算、压缩、模型请求和调用校验使用同一快照。
- 复用 Plan 权限、Hook、安全审计、审批、执行台账和结果治理，不产生 facade 旁路。

**Non-Goals:**

- 删除、合并或改变底层本地工具实现、MCP 工具名和 MCP 参数契约。
- 引入 MCP search/describe/call 渐进加载或改变 MCP 的直出行为。
- 用 bash 替代所有结构化能力；文件读取、搜索、修改和用户交互仍使用专用职责型 schema。
- 在同一次 run 内动态增删模型顶层工具 schema。

## Decisions

### 1. 模型本地工具固定为 OpenCode 风格 13 个职责名

普通模式和 executing 阶段的本地模型工具集合固定为：

| 模型工具        | 职责与底层能力边界                                                          |
| --------------- | --------------------------------------------------------------------------- |
| `bash`        | 构建、测试、Git、包管理和组合命令；复用 terminal 的白名单、超时、审批和审计 |
| `read`        | 读取文件，也能读取目录；聚合`fs_read_file` 与 `fs_list_dir`             |
| `glob`        | 按路径模式找文件；聚合文件路径搜索能力                                      |
| `grep`        | 搜索文件内容；必要时复用现有搜索实现或新增受守卫的内容搜索 facade           |
| `edit`        | 对已有文件做结构化局部修改；复用`code_edit` 的 diff 预览与审批            |
| `write`       | 以结构化参数写入文件；复用`fs_write_file` 的路径守卫与审批                |
| `apply_patch` | 应用统一 patch；复用现有 diff/code 编辑执行链，不绕过路径守卫               |
| `task`        | 委派子 Agent；沿用 AgentLoop 的子任务边界和会话/审批上下文                  |
| `webfetch`    | 获取指定外部 URL 内容；沿用网络访问和结果治理策略                           |
| `websearch`   | 搜索外部信息；适配现有`web_search` 能力                                   |
| `todowrite`   | 更新任务状态；适配现有`todo_write`                                        |
| `skill`       | 加载和使用技能；适配现有 Skill 注册/加载链路                                |
| `question`    | 向用户提问并等待回答；通过现有 UI/事件总线交互                              |

这些是模型协议层名称，不要求底层 Registry 工具改名。Git status/log/diff/commit/branch/stash、代码导航、文件移动/删除等底层能力可继续存在，但不再以独立本地 schema 暴露；需要执行时由 `bash` 或对应 facade 按现有安全策略承载。未来新增本地工具默认不直接暴露，除非显式加入职责映射。

`bash` 的职责是“组合和长尾执行”，不是取消安全边界：命令白名单、工作区限制、超时、审批、安全审计和结果脱敏必须保持。

### 2. MCP 继续全量直接加载

对于每个 enabled 且 ready 的 MCP Server，当前发布的全部 Function Tool schema SHALL 继续由 `McpToolAdapter` 转换并直接加入模型请求。MCP 工具不进入本地 13 工具预算，不经过 `tool_search`、`tool_describe`、`tool_call`，也不因本变更被合并成一个 MCP facade。

connecting、disabled、断开或未完成发布的 MCP Server 不进入本次 run 的 MCP 快照。MCP 状态在 run 中途变化时，模型可见集合保持本次快照；执行阶段由现有 Manager/Router 返回明确 unavailable 结果。

这样可以保持 MCP 工具的现有调用契约和模型可见名称，只针对本地重复 schema 做收敛。

### 3. 在 Registry 与 AgentLoop 之间增加本地暴露策略和 facade 适配层

新增 `ToolExposurePolicy` 或等价组件，输入完整本地 Registry 快照、MCP 快照和 Plan 阶段，输出不可变的运行级工具快照：

- `localTools`：13 个职责型本地 schema（Plan 阶段为只读子集）；
- `mcpTools`：本次 run 全部 ready MCP schema，planning/reviewing 再叠加现有 permission 只读过滤；
- `registeredLocalCount`、`exposedLocalCount`、`exposedMcpCount` 和 schema token 统计。

Facade 只负责把模型名称和结构化参数映射到底层真实 ToolCall；真实执行仍交给 `ToolRouter`。ToolRouter 继续按底层真实工具做 lookup、权限、Hook、参数校验、安全审计、审批、执行台账和结果治理。

备选方案是只靠 system prompt 告诉模型少用现有工具，但它既不能减少 schema 数量，也不能保证模型面对重复工具时稳定选择，因此不采用。

### 4. Plan 模式保留只读边界

planning/reviewing 阶段从职责型集合中只暴露：`read`、`glob`、`grep`、`webfetch`、`websearch`、`skill`、`question` 和 `todowrite`（其中 `todowrite` 继续遵循现有特例）。`bash`、`edit`、`write`、`apply_patch`、`task` 不进入允许调用范围，因为它们可能执行命令、修改文件或委派副作用。

executing 阶段恢复完整 13 个本地职责工具。即使模型伪造隐藏的底层工具名，AgentLoop 与 ToolRouter 仍拒绝越过当前阶段的模型可见面和权限边界。

### 5. 每次 Agent run 只创建一次不可变快照

AgentLoop 在 run 开始时捕获本地 Registry 和当前 ready MCP 工具快照，后续所有 step 复用同一暴露快照。schema token 估算、上下文压缩、每轮 AI SDK 请求以及调用范围校验必须使用同一对象。Registry、MCP 状态或配置变化从下一个 run 生效。

这只保证模型协议稳定，不承诺底层服务持续在线；执行时不可用仍按现有错误语义返回。

### 6. 可观测性只记录统计，不记录敏感内容

每次快照创建记录 session/run、Plan 阶段、本地注册数、本地暴露数、MCP 暴露数及 schema token 估算。Facade 调用记录模型职责名、底层工具名、来源和耗时，但不得记录完整参数、完整 schema、工具结果或密钥。

## Risks / Trade-offs

- [统一职责工具的参数可能覆盖不足] → facade 参数保留底层结构化约束；无法安全聚合的能力单独补充职责映射，而不是退回全量本地 schema。
- [模型把所有任务都交给 bash] → system prompt 明确优先使用 read/glob/grep/edit/write/apply_patch；bash 仍受白名单、审批和审计限制。
- [MCP schema 继续增加 token] → 这是本次明确保留的兼容性选择；后续如需优化 MCP，应另开 change，不能在本 change 偷换为渐进加载。
- [运行快照与 MCP 实时状态不一致] → 快照稳定模型契约，执行前仍由 Router/Manager 校验可用性并返回明确失败。
- [task/question facade 引入交互延迟] → 复用现有事件总线和会话机制，分别设置稳定超时与取消语义。

## Migration Plan

1. 为 13 个职责名定义 schema、底层映射和权限分类，先补 facade/策略单元测试。
2. 接入 AgentLoop，使本地请求改用职责型集合，同时保持 ready MCP 全量直出。
3. 接入 Plan 只读过滤、run 级快照和 token 估算复用，补 MCP 状态变化回归测试。
4. 更新 system prompt，运行相关测试和 `npm run compile` 后启用新默认策略。

本变更不迁移持久化数据，不改变历史消息格式。若需回滚，可恢复旧的本地 schema 物化路径；MCP 注册、工具实现和会话数据无需迁移。

## Open Questions

- `grep`、`webfetch`、`task`、`question` 在现有代码中的最佳承载模块需要实现阶段按当前架构落位，但模型协议名称固定。
- `apply_patch` 与 `edit` 的参数是否需要完全区分为 unified diff 和结构化 replacement，应以现有 `code_edit`/diff 契约为准，不能弱化审批和路径守卫。
