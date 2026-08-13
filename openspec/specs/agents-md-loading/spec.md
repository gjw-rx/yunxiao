# agents-md-loading Specification

## Purpose
定义 AGENTS.md（Agent 指令文件）的默认加载机制：用户级全局 `~/.claude/AGENTS.md`（回退 CLAUDE.md）与项目级 `AGENTS.md` 默认注入系统提示词，与「配置来源」解耦，支持多来源拼接、来源标注、大小上限与失败降级。
## Requirements
### Requirement: 用户级全局 AGENTS.md 默认加载

系统 SHALL 默认加载用户级全局 Agent 指令文件 `~/.claude/AGENTS.md`（以 `os.homedir()` 拼接）；不存在或不可读时 SHALL 尝试回退 `~/.claude/CLAUDE.md`（对称兼容）。全局文件加载 SHALL 与「配置来源」（syncSource）解耦。

#### Scenario: 全局 AGENTS.md 存在
- **WHEN** `~/.claude/AGENTS.md` 存在
- **THEN** 系统读取其内容作为全局 Agent 规范注入系统提示词

#### Scenario: 全局 CLAUDE.md 回退
- **WHEN** `~/.claude/AGENTS.md` 不存在但 `~/.claude/CLAUDE.md` 存在
- **THEN** 系统以 `~/.claude/CLAUDE.md` 内容作为全局 Agent 规范

#### Scenario: 全局文件不存在
- **WHEN** `~/.claude` 下既无 `AGENTS.md` 也无 `CLAUDE.md`
- **THEN** 系统跳过全局部分，不报错，不中断会话

### Requirement: 项目级 AGENTS.md 默认加载

系统 SHALL 默认加载项目级 `AGENTS.md`，与「配置来源」解耦：配置来源为 `none` 或 `trae` 时仍加载项目级 `AGENTS.md`。项目级 `CLAUDE.md` 存在时 SHALL 优先于项目级 `AGENTS.md`（优先级规则由 project-rules-injection 能力规定）。

#### Scenario: none 来源加载项目 AGENTS.md
- **WHEN** 配置来源为 `none` 且项目根存在 `AGENTS.md`
- **THEN** 系统加载并注入项目级 `AGENTS.md`

#### Scenario: trae 来源加载项目 AGENTS.md
- **WHEN** 配置来源为 `trae` 且项目根存在 `AGENTS.md`
- **THEN** 系统加载并注入项目级 `AGENTS.md`（与 Trae 规则并存）

### Requirement: 全局与项目内容拼接与来源标注

当全局与项目级 Agent 文件同时存在时，系统 SHALL 将内容拼接后注入：全局内容在前，项目内容在后（项目级优先级更高）。系统提示词中 SHALL 标注每个来源文件的完整路径。

#### Scenario: 全局与项目同时存在
- **WHEN** `~/.claude/AGENTS.md` 与项目根 `AGENTS.md` 均存在
- **THEN** 系统按「全局在前、项目在后」拼接注入，并逐项标注两处来源文件路径

### Requirement: 读取安全与失败降级

读取用户级与项目级 Agent 文件 SHALL 遵循单份大小上限（64KB）：超限的份 SHALL 跳过且不影响其他份的注入，并记录日志。读取失败（权限错误、非文件等）SHALL 静默降级，不影响对话主流程。

#### Scenario: 单份超限
- **WHEN** 用户级 `AGENTS.md` 超过大小上限而项目级文件正常
- **THEN** 系统跳过用户级该份并记录日志，项目级文件仍正常注入

#### Scenario: 读取失败
- **WHEN** 读取 `~/.claude/AGENTS.md` 抛出异常（如权限错误）
- **THEN** 系统跳过全局部分，会话正常运行，错误被记录到日志

