## Why

当前云效 Agent 在复杂任务中会直接从分析进入修改，用户无法先审阅执行方案，也缺少一个能在探索阶段强制阻止写入和执行类工具的会话模式。现有 `todo_write` 已具备结构化任务、会话持久化和进度展示能力，适合作为 Plan 模式的计划载体，避免再引入一套文本解析和进度协议。

## What Changes

- 新增会话级 Plan 模式，用户可在聊天界面进入或退出只读规划状态，并在会话切换或恢复后保持正确状态。
- Plan 模式下向模型注入专用规划指令，仅暴露只读工具与 `todo_write`，同时在工具路由执行前兜底拒绝不允许的调用。
- 要求模型使用现有 `todo_write` 创建和修订结构化计划，由既有 Todo 面板展示计划内容。
- 计划生成后提供“执行计划”“继续规划”“退出规划”操作；只有用户明确选择执行后才恢复完整工具集并沿用 Todo 状态跟踪进度。
- 补充模式切换、工具隔离、计划确认、会话恢复和异常路径的自动化测试与关键日志。

## Capabilities

### New Capabilities

- `plan-mode`: 定义 Plan 模式的会话状态、只读工具边界、结构化计划生成、用户确认执行及恢复行为。

### Modified Capabilities

无。

## Impact

- Agent 运行链路：`src/agent/agentLoop.ts`、系统提示与工具定义物化过程。
- 工具安全边界：`src/core/toolRouter.ts`、`src/core/toolRegistry.ts` 或新增的会话工具策略组件。
- 会话持久化：会话索引/文件存储及 `LocalSessionManager` 的模式读写接口。
- Webview：`src/chatPanel.ts` 中的模式切换、计划确认操作和现有 Todo 面板联动。
- 复用现有 `SessionTodoStore`、`TodoWriteTool` 与 `todo_state_change` 事件，不新增第三方依赖，不改变已有工具或模型 API。
