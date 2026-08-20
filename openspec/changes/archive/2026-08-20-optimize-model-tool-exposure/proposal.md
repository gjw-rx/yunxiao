## Why

当前 AgentLoop 在普通模式下会把 ToolRegistry 中全部 21 个内置工具以及所有 ready MCP 工具逐轮发送给模型，Plan 模式也只按权限过滤出 13 个只读工具。随着本地能力增长，重复的文件、代码、Git 专用 schema 会增加请求 token 和工具选择歧义。需要参考 OpenCode，将本地模型可见面收敛为少量稳定的职责型工具；MCP 保持现状，ready 工具仍全部直接发送给模型。

## What Changes

- 新增统一的本地模型工具暴露策略，在不删除现有底层实现的前提下，将模型可见工具固定为 OpenCode 风格的职责型工具。
- 普通/执行阶段直接暴露 `bash`、`read`、`glob`、`grep`、`edit`、`write`、`apply_patch`、`task`、`webfetch`、`websearch`、`todowrite`、`skill`、`question` 13 个本地工具。
- `bash` 统一承载构建、测试、Git、包管理和组合命令；`read` 同时支持文件和目录；结构化文件修改由 `edit`、`write`、`apply_patch` 分工承担。
- 现有重复的本地专用工具保留在 Registry 作为内部执行实现，由职责型 facade/adapter 路由，不再逐个发送给模型。
- Plan 的 planning/review 阶段在上述职责型工具之上继续应用现有只读权限边界；ToolRouter 仍以完整权限策略做执行时兜底。
- MCP Function Tools 保持现状：普通/执行阶段所有 enabled 且 ready 的 MCP 工具继续完整、直接转换为模型 schema；Plan 阶段只叠加现有 permission 只读过滤，不接入 search/describe/call 渐进披露。
- 工具暴露快照在单次 Agent run 内保持稳定；本地 Registry 与 MCP 状态变化从下一次 run 生效，避免执行中工具集合漂移。
- 增加可观测性，记录本地职责型工具数、MCP 直出数、schema 估算 token 与选择原因，但不记录敏感参数或完整 schema。
- 保留现有 ToolRouter、审批、安全审计、参数校验、结果治理和 call ID 链路；职责型 facade 不得绕过任何本地执行边界。

## Capabilities

### New Capabilities

- `model-tool-exposure-policy`: 定义 OpenCode 风格本地职责型工具分组、会话级稳定快照、预算治理与可观测性。

### Modified Capabilities

- `ai-sdk-tool-schema-adapter`: 从“转换并暴露 Registry 全量本地 schema”调整为“转换 13 个职责型本地 schema，并继续转换所有 ready MCP schema”。
- `mcp-function-tool-bridge`: 保持 ready MCP 工具全量直接进入模型 schema，继续使用现有 ToolRouter 路由与动态可用性语义。
- `plan-mode`: planning/review 使用职责型工具名的只读子集，同时禁止 bash/edit/write/apply_patch/task 等非只读能力。

## Impact

- 主要影响 `src/agent/agentLoop.ts`、`src/agent/toolAdapter.ts`、`src/core/toolRegistry.ts` 附近的工具物化链路，并新增本地职责型 facade/暴露策略组件。
- MCP Manager 与 `McpToolAdapter` 继续负责动态注册和真实执行；不新增 MCP 渐进发现桥，也不改变 MCP 直出行为。
- Plan 模式、上下文 token 估算、自动压缩和 LLM 请求必须复用同一份 run 级工具快照。
- 需要补充本地职责型工具映射、MCP 全量直出、Plan 只读收敛、run 稳定性、路由安全与 schema token 观测测试。
- 不引入新的外部依赖，不删除现有底层工具，不改变 MCP 模型可见名称与 ToolRouter 权限语义；本地模型可见名称统一采用 OpenCode 风格名称。
