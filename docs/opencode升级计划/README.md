# OpenCode 对标升级计划

本目录把云效 Coding Agent 与 OpenCode 的 harness 差异拆成可独立实施的能力卡片。每份文档固定回答五件事：云效现状、OpenCode 已实现的做法、能力差距、建议落点和验收信号。

## 阅读顺序

1. 先读 [01-运行时总览](01-运行时总览.md)、[02-会话与事件模型](02-会话与事件模型.md) 与 [03-恢复和预算](03-恢复和预算.md)，确定 harness 的事实来源。
2. 再读文件、编辑、终端和权限四类本地执行能力，确定插件边界。
3. 最后读多 Agent、MCP、插件、模型、可观测性和体验，安排平台化演进。

## 结论摘要

云效的优势是 VSCode 原生代码智能、LangGraph 编排、记忆、上下文压缩及本地路径守卫；OpenCode 的优势是把这些能力放进统一、可持久、可回放、可撤销、可授权的 Agent runtime。升级目标是“云端编排与记录 + 插件受策略约束的本地执行”，不是复制 OpenCode 技术栈。

| 层级 | 云效现状 | 优先升级方向 |
|---|---|---|
| Runtime | LangGraph interrupt + 插件 SSE 续流 | 持久 Run/Step/ToolCall/Event |
| Workspace | 工具级读写、diff 和路径守卫 | 文件版本、快照、patch、revert |
| Governance | 工具级审批与正则终端拦截 | 角色、范围、过期授权和预算 |
| Ecosystem | Skill/Tool 基础与预留 MCP | MCP 生命周期、插件 hooks、子 Agent |
| Experience | 单一 Webview 流式视图 | 可恢复运行时间线和真实 E2E |

本目录对应 OpenSpec 变更：[opencode-harness-baseline](../../openspec/changes/opencode-harness-baseline/proposal.md)。
