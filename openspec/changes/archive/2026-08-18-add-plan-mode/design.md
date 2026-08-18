## Context

当前 `AgentLoop` 在每轮请求中从 `ToolRegistry` 物化全部工具定义，`ToolRouter` 再按工具权限执行审批和路由。`todo_write` 已被定义为 `read` 权限的会话元数据工具，具备全量任务快照、持久化、模型上下文恢复和 Webview Todo 面板更新能力。

Pi 的 Plan Mode 位于 coding-agent 扩展层，而不是另建 planner Agent 或修改 core loop：它在 loop 前切换工具和注入指令、工具执行前拦截危险命令、loop 后解析计划并安排执行。云效 Agent 没有 Pi 的扩展事件层，但在 `AgentLoop`、`ToolRouter`、`LocalSessionManager` 和 `ChatPanel` 已有等价边界。云效还拥有结构化 `todo_write`，因此无需复刻 Pi 的 `Plan:` 正则解析和 `[DONE:n]` 文本标记。

本变更跨越 Agent、工具安全、会话存储与 Webview，且 Plan 模式的只读承诺不能只依赖提示词或前端状态。

## Goals / Non-Goals

**Goals:**

- 在同一 Agent、同一会话和同一消息历史中提供规划、审阅、执行的状态流转。
- 规划阶段仅允许明确标记为 `read` 的工具，同时保留 `todo_write` 以生成结构化计划。
- 在模型可见工具与本地执行入口同时执行相同策略，防止隐藏工具被幻觉调用或绕过。
- 复用现有 Todo 快照作为唯一计划数据源，并复用既有进度面板、压缩恢复和任务上下文。
- 持久化每个会话的 Plan 阶段，使切换会话和扩展重启后恢复一致。

**Non-Goals:**

- 不引入独立 planner 模型、子 Agent 或第二条 Agent loop。
- 不实现 Pi 的 Bash 命令正则白名单；Plan 模式不暴露 `terminal_exec`。
- 不解析 Markdown `Plan:` 文本，也不使用 `[DONE:n]` 标记推断进度。
- 不改变现有审批网关；执行计划后写入、执行和破坏性工具仍按原规则审批。
- 不提供 Todo 的用户手工编辑器，计划内容仍由模型通过 `todo_write` 维护。

## Decisions

### 1. 使用四阶段会话状态机，不建立新的 Agent loop

新增会话级阶段：`normal`、`planning`、`review`、`executing`，以及用于判断退出时是否清理本轮草案的 `draftCreated` 标记。状态按会话持久化，但计划步骤不复制到状态对象，始终以 `SessionTodoStore` 为唯一数据源。

主要转换如下：

- `normal -> planning`：用户通过输入区模式入口或 `/plan` 进入；当前 Agent run 必须空闲。
- `planning -> review`：本轮成功执行了非空 `todo_write`，且该 Agent run 正常结束。
- `review -> planning`：用户选择继续规划并提交补充要求。
- `review -> executing`：用户明确选择执行，恢复全部工具并自动触发同会话执行 turn。
- `planning/review -> normal`：用户退出；若本轮已创建草案则清空该草案。
- `executing -> normal`：Todo 快照中不再存在 `pending` 或 `in_progress` 项。

进入 Plan 模式时不复制或预先清空旧 Todo。只有当前规划 run 中成功的 `todo_write` 才能使阶段进入 `review`，避免把旧快照误判为新计划。若已有活跃 Todo 或 Agent 正在运行，系统拒绝开始新的 Plan 会话，避免覆盖正在执行的任务。

替代方案是创建独立 planner Agent。该方案会拆分会话历史、工具上下文和 Todo 状态，还需要额外的模型配置及结果转交，因此不采用。

### 2. 以结构化 `todo_write` 作为计划提交协议

规划提示要求模型先用只读工具调研，再以一次 `todo_write` 提交完整、有序的计划，最后停止并等待用户选择。`AgentLoop` 记录当前 run 是否获得成功且非空的 `todo_write` 结果；仅该信号可触发 `review`。

用户选择执行时，宿主先原子切换到 `executing`，再向同一会话启动一条不在聊天区展示的执行指令，要求模型从第一项未完成任务开始，并继续用 `todo_write` 更新状态。进度完成依据 Todo 的结构化状态，而不是从助手文本猜测。

替代方案是照搬 Pi，从助手 Markdown 中提取编号列表并解析完成标记。该协议容易受格式、语言和遗漏标记影响，并与现有 Todo 数据重复，因此不采用。

### 3. 工具策略采用“请求过滤 + 路由兜底”双层执行

`SessionPlanModeStore`（或等价服务）提供统一的 `isToolAllowed(sessionId, schema)` 判断：

- `planning` 与 `review` 仅允许 `schema.permissions === 'read'`；当前 `todo_write` 因声明为 `read` 而自然保留。
- `normal` 与 `executing` 允许现有完整工具集。

`AgentLoop` 在物化 LLM 工具定义前按该策略过滤。`ToolRouter.route` 在参数 Hook、审批和执行之前再次检查同一策略，并对禁止调用返回结构化 `cancelled` 结果。MCP 工具继续使用现有 annotations 的保守权限映射；未明确 `readOnlyHint` 的 MCP 工具在 Plan 模式下不可见且不可执行。

不采用 Pi 的“保留 Bash 再用正则判断命令”方案，因为 shell 组合、脚本间接写入和平台差异无法形成可靠只读边界。用户仍可使用文件读取、搜索、代码智能、Git 只读和明确只读的 MCP/Web 工具完成调研。

### 4. 规划上下文为临时系统消息，不写入会话历史

`AgentLoop` 每轮构建消息时按会话阶段加入临时 Plan 指令。`planning` 指令声明只读边界、要求必要时澄清、要求使用 `todo_write` 提交计划并禁止执行修改；`executing` 继续复用现有 Todo 活跃上下文和通用 Todo 规则。

Plan 指令不写入 `MessageStore`，退出后不会残留并误导普通会话。规划阶段同时抑制现有“继续执行活跃任务”的 Todo 恢复提示，避免语义冲突；Todo 工具结果仍保留在正常历史中。

替代方案是动态重写基础 system prompt。临时消息更局部，不影响项目规则、Skill、MCP 指令的组装，也更容易在退出模式后彻底移除。

### 5. Plan 阶段与 Todo 分开持久化，通过类型化事件同步 UI

会话存储新增可选 Plan 状态字段和原子读写接口；旧索引缺少该字段时按 `normal` 处理。Todo 快照继续由 `SessionTodoStore` 保存，避免双写步骤列表。

模式切换发出类型化 `plan_mode_change` 事件，Host-to-Webview 消息携带阶段与可用操作。Webview 在输入区显示 Plan 模式入口/状态，并在 Todo 面板进入 `review` 时显示“执行计划”“继续规划”“退出规划”。所有宿主动作再次校验会话 ID、当前阶段和 Agent 是否空闲，防止重复点击和跨会话事件。

`/plan` 作为内置宿主动作进入或退出模式，不作为用户消息发送给模型；模式按钮与斜杠命令调用同一 `LocalSessionManager` 接口。

## Risks / Trade-offs

- [部分第三方 MCP 错误声明 `readOnlyHint`] → 继续依赖现有保守映射；未声明只读默认视为 `execute`，并由路由层二次拒绝。
- [模型未调用 `todo_write` 或写入空列表] → 保持 `planning`，不展示执行操作，允许用户补充要求或退出。
- [执行 turn 失败或被取消] → 保持 `executing` 与当前 Todo 快照，完整工具策略不变；用户可在同会话继续，已完成项不会丢失。
- [扩展在状态切换与自动执行之间退出] → 先持久化 `executing` 再启动 run；恢复后展示执行中状态和现有 Todo，不自动重复启动工具调用。
- [只读工具仍可能访问网络或敏感文件] → Plan 模式只保证不执行标记为写入/执行/破坏性的工具，不替代现有路径守卫、脱敏或网络信任策略。
- [额外状态增加会话索引兼容面] → 字段保持可选并提供严格规范化，坏值回退 `normal`，不阻塞历史加载。

## Migration Plan

1. 先增加可选 Plan 状态的类型、存储和默认迁移，确保旧会话全部按 `normal` 加载。
2. 接入统一工具策略与 Agent 临时提示，再接入状态转换和 Todo 完成联动。
3. 最后启用 Webview 入口与审阅操作，使前端不会早于宿主能力暴露 Plan 模式。
4. 回滚时移除 UI 入口和运行时策略即可；索引中的未知可选字段由旧版本忽略，Todo 快照仍保持兼容。

## Open Questions

无。首版固定使用权限级别形成只读边界，不提供用户可配置的 Plan 工具白名单。
