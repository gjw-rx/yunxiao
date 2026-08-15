## ADDED Requirements

### Requirement: RTK 仅转换 terminal_exec 命令
当 Hooks 总开关和 RTK 集成均启用时，系统 SHALL 仅对本地 `terminal_exec` 的 `command` 参数调用 RTK Transform Hook。Adapter SHALL 将原始命令作为单一参数传给已检测的 RTK 可执行文件的 `rewrite` 子命令；只有得到非空、有效的改写结果时才替换最终命令。系统 SHALL 不改写 `simple-git` 本地 Git 工具、文件工具、代码工具或 MCP 工具。

#### Scenario: 支持的终端 Git 命令被改写
- **WHEN** `terminal_exec` 收到 `git status`，且 RTK 返回 `rtk git status`
- **THEN** 系统执行 `rtk git status`，并将其压缩后的终端输出作为工具结果继续治理和回传

#### Scenario: 结构化 Git 工具不受影响
- **WHEN** 模型调用 `git_status`
- **THEN** 系统继续使用既有 `simple-git` 实现，且不调用 RTK Adapter

### Requirement: RTK 调用安全且透明
RTK Adapter SHALL 通过无 Shell 的子进程调用 RTK，命令不得被拼接进 Shell 字符串。Adapter SHALL 不调用 `rtk init`、不下载或升级 RTK、不得修改 Claude、Codex 或其他 Agent 的配置，也不得向模型注入要求使用 RTK 的提示词。

#### Scenario: 命令包含引号或空格
- **WHEN** `terminal_exec.command` 包含引号、空格或其他 Shell 字符
- **THEN** Adapter 将该完整命令作为一个 `rewrite` argv 参数传递，而不由 Adapter 自身解释或执行其中的 Shell 语法

### Requirement: RTK 不可用时保持原始执行语义
当 RTK 未检测到、被禁用、超时、返回非零退出码、没有改写结果或子进程异常时，Adapter SHALL 保留原始命令并继续既有终端执行流程。该优化失败 SHALL 记录有界中文日志，但 SHALL NOT 单独阻断用户命令。

#### Scenario: RTK 未安装
- **WHEN** 用户启用 RTK 但配置路径不可执行或 RTK 检测失败
- **THEN** `terminal_exec` 执行原始命令，且设置页显示不可用状态

#### Scenario: 命令没有 RTK 等价形式
- **WHEN** RTK `rewrite` 未返回改写结果
- **THEN** 系统执行原始命令，不将该情况作为工具错误返回给模型

### Requirement: RTK 检测和固定样例测试
Host SHALL 支持检测配置的 RTK 可执行文件，并同时验证版本信息与 `rewrite` 能力。Host SHALL 支持以固定无副作用样例 `git status` 请求测试改写，并仅向设置页返回检测状态、版本、路径显示值、原始样例与改写样例或有界错误摘要。

#### Scenario: 成功检测并测试改写
- **WHEN** 用户在 Hooks 设置页触发 RTK 检测或测试，且可执行文件支持 `rewrite`
- **THEN** 页面显示可用状态、版本和 `git status` 的改写结果，且不执行该样例命令

#### Scenario: 测试失败不执行用户命令
- **WHEN** RTK 测试调用失败
- **THEN** Host 返回有界错误状态，且不会执行任何用户提供或固定样例的实际 Git 命令
