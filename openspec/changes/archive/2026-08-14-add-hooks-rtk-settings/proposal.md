## Why

云效 Agent 目前缺少统一的生命周期扩展点，无法在会话和工具调用的关键时机安全、可观测地注入优化或策略。终端输出会直接进入模型上下文；对 Git、测试和构建等高噪声命令，接入 RTK 的命令改写与输出过滤可以在不改变模型工作流的前提下降低输入上下文负担。

## What Changes

- 新增 Hooks 运行时，提供 `session_start`、`pre_tool_call`、`post_tool_call` 与 `session_end` 四种基础事件，并对 Hook 执行提供顺序、超时、隔离与日志能力。
- 新增受信任的 RTK Transform Hook：仅在本地 `terminal_exec` 调用前调用 RTK 的 `rewrite` 能力，将可支持命令透明改写为 RTK 命令。
- 保存原始与最终工具参数；RTK 改写后重新校验，并以原始命令和最终命令共同参与安全审计、白名单判断和审批展示，防止改写绕过安全边界。
- 当 RTK 不可用、超时、无改写结果或执行失败时，继续执行原始命令；不自动安装 RTK，也不修改其他 Agent 的全局配置。
- 在插件设置页的 MCP 下方新增“Hooks”分类，展示并管理 Hooks 总开关与 RTK 集成的启用状态、可执行文件路径、检测状态和测试改写操作，视觉风格与既有设置页一致。

## Capabilities

### New Capabilities

- `hook-runtime`: 提供四类基础生命周期 Hook、执行隔离、配置快照与受信任参数转换契约。
- `rtk-terminal-optimization`: 通过 RTK Transform Hook 优化 `terminal_exec` 的可支持命令输出，并提供可检测、可配置的集成。

### Modified Capabilities

- `terminal-tools`: 终端工具在 RTK 改写场景中保留原始与最终命令的安全、白名单和审批语义。
- `security-boundary`: 集中安全审计覆盖 Hook 改写前后的有效工具参数，禁止参数转换绕过既有安全策略。
- `settings-page`: 设置分类增加位于 MCP 下方的 Hooks 页面，并提供 Hooks 与 RTK 的交互配置。

## Impact

- 新增 Hooks 核心模块、RTK Adapter、配置读写与设置页消息协议。
- 调整 `ToolRouter` 的工具调用流水线，以及 `TerminalExecTool` 的分类和审批上下文。
- 修改设置页导航、前端组件与相应样式；不改变 MCP 设置功能。
- 依赖用户已安装且可执行的 RTK 二进制；第一版不新增 npm 依赖，也不自动下载外部程序。
