## 1. 职责型工具契约与测试基线

- [x] 1.1 定义 13 个本地职责型工具的模型 schema、底层映射、权限级别和错误契约，并为新增类型与函数补齐中文注释/JSDoc
- [x] 1.2 先为 `bash`、`read`、`glob`、`grep`、`edit`、`write`、`apply_patch` 的参数映射和路径/命令安全边界编写单元测试
- [x] 1.3 先为 `task`、`webfetch`、`websearch`、`todowrite`、`skill`、`question` 的事件、网络、会话和状态更新映射编写单元测试
- [x] 1.4 先为普通模式固定 13 个本地职责工具、隐藏 `fs_*`/`code_*`/`git_*` 专用 schema 和未知本地工具默认不暴露编写暴露策略测试

## 2. 本地暴露策略与 facade

- [x] 2.1 实现 `ToolExposurePolicy`，从完整本地 Registry 快照生成普通/executing 阶段的 13 个职责型本地 schema，并为 Plan 阶段生成只读子集
- [x] 2.2 实现 `read` 对文件与目录的聚合、`glob` 路径模式查找和 `grep` 内容搜索 facade，复用路径守卫、结果截断和脱敏
- [x] 2.3 实现 `bash` 到 terminal 执行链的适配，确认构建、测试、Git、包管理和组合命令继续经过白名单、工作区、超时、审批和审计
- [x] 2.4 实现 `edit`、`write`、`apply_patch` 到现有代码编辑/文件写入/diff 执行链的适配，确认 diff 预览、路径守卫和审批不被绕过
- [x] 2.5 实现 `task`、`webfetch`、`websearch`、`todowrite`、`skill`、`question` facade，并接入现有 AgentLoop、网络、事件总线、Skill 和会话边界

## 3. AgentLoop 与 AI SDK schema 接入

- [x] 3.1 在每次 Agent run 开始时捕获一次本地 Registry 和 ready MCP 快照，后续 step 不重新读取实时 Registry 改变可见集合
- [x] 3.2 调整 AI SDK tool adapter 仅转换 13 个职责型本地 schema，并保持现有 ready MCP 工具全部直接转换为独立 schema
- [x] 3.3 让 schema token 估算、上下文压缩阈值和每轮模型请求复用同一运行级本地/MCP 工具快照，补充中途注册或 MCP 状态变化仅在下一 run 生效的测试
- [x] 3.4 在 AgentLoop 调用入口拒绝未暴露的底层本地专用工具名，并将职责型 facade 调用统一转为底层 ToolCall 后交给 ToolRouter

## 4. MCP 与 Plan 安全回归

- [x] 4.1 调整 MCP 发布快照，使 enabled 且 ready Server 的全部工具继续直接进入普通/executing 模型请求；connecting/disabled Server 不进入快照
- [x] 4.2 验证 MCP 直出调用仍完整经过 ToolRouter 的 lookup、Plan 权限、Hook、JSON Schema 校验、安全审计、审批、执行台账和结果治理
- [x] 4.3 验证 planning/reviewing 只暴露本地只读职责子集和 permission 为 read 的 MCP schema，隐藏写/执行/破坏性工具在 Hook 和审批前被拒绝
- [x] 4.4 验证 Plan 从 reviewing 进入 executing 后恢复完整 13 个本地职责工具，且 ready MCP 继续全量直出

## 5. 提示与整体验证

- [x] 5.1 更新 system prompt 的工具选择说明：优先使用 read/glob/grep/edit/write/apply_patch 等结构化职责工具，bash 用于构建、测试、Git、包管理和组合命令
- [x] 5.2 更新工具目录与日志说明，明确 MCP 不使用渐进发现、不改变现有直出行为，并记录本地职责工具数、MCP 暴露数和 schema token 估算
- [x] 5.3 运行相关单元/集成测试，确认普通模式本地固定 13 个工具、ready MCP 全量可见、Plan 只读边界和底层受控执行均通过
- [x] 5.4 运行 `npm run compile` 并修复本变更引入的类型、lint 或构建错误
- [x] 5.5 使用 `openspec validate optimize-model-tool-exposure --strict` 验证 change artifacts 与 capability delta 完整有效
