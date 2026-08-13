# project-rules-injection Specification

## Purpose
定义项目规范（Agent 指令文件）的加载与注入：项目级 `CLAUDE.md`（优先）与 `AGENTS.md`（默认加载）解析、作为「项目级规范」注入系统提示词并标注来源、读取安全降级与每次运行读取最新内容。AGENTS.md 默认加载规则与「配置来源」解耦，与 agents-md-loading 能力共同构成完整的 Agent 文件机制。
## Requirements
### Requirement: 项目规范文件解析

系统 SHALL 在每次会话运行时加载项目规范文件：项目级 `CLAUDE.md` 优先，存在时 SHALL 仅使用 `CLAUDE.md`；不存在时 SHALL 加载项目级 `AGENTS.md`；两者均不存在时项目级部分为空。`AGENTS.md` 作为默认加载的 Agent 指令文件，SHALL 与「配置来源」（syncSource）解耦：配置来源为 `none` 或 `trae` 时仍加载项目级 `AGENTS.md`（用户级与项目级 AGENTS.md 的默认加载与拼接规则由 agents-md-loading 能力规定）。

#### Scenario: 项目存在 CLAUDE.md

- **WHEN** 项目根存在 `CLAUDE.md`
- **THEN** 系统以 `CLAUDE.md` 内容作为项目级规范注入系统提示词，不读取项目级 `AGENTS.md`

#### Scenario: 仅存在 AGENTS.md

- **WHEN** 项目根不存在 `CLAUDE.md` 但存在 `AGENTS.md`
- **THEN** 系统以 `AGENTS.md` 内容作为项目级规范注入系统提示词

#### Scenario: 来源为 none 时仍加载 AGENTS.md

- **WHEN** 配置来源为 `none` 且项目根存在 `AGENTS.md`
- **THEN** 系统仍加载并注入项目级 `AGENTS.md`

#### Scenario: 两者均不存在

- **WHEN** 项目根既无 `CLAUDE.md` 也无 `AGENTS.md`
- **THEN** 系统不注入项目级规范，系统提示词其余部分正常构建

### Requirement: 注入系统提示词并声明遵循

系统 SHALL 将项目规范以「项目级规范」身份注入 `buildSystemPrompt` 产出的系统提示词，并包含明确声明：以下内容为项目级规范，任何开发工作都必须遵循。注入内容 SHALL 标注全部来源文件路径（多来源时逐项列出）。系统提示词中 SHALL 同时保留原有的 agent 提示词、环境信息与可用 skill 段落。

#### Scenario: 规范进入系统提示词

- **WHEN** 项目存在 `CLAUDE.md` 且 Agent 会话启动
- **THEN** 系统提示词包含 `<project_rules>` 段落，段落内声明「项目级规范，任何开发必须遵循」并附 `CLAUDE.md` 内容与来源路径

#### Scenario: 多来源标注

- **WHEN** 用户级与项目级 AGENTS.md 均存在且 Agent 会话启动
- **THEN** 系统提示词的项目规范段落标注两处来源文件路径

#### Scenario: 原有段落不受影响

- **WHEN** 项目规范注入生效时 Agent 会话启动
- **THEN** 系统提示词仍包含原有的 agent 提示词、`<env>` 环境段与 `<available_skills>` 段

### Requirement: 读取安全与失败降级

读取项目规范文件 SHALL 遵循文件读取安全策略（大小上限、非文本文件检测等）。文件过大时 SHALL 截断或跳过；读取失败 SHALL 静默降级（不注入、不影响对话主流程）并记录日志。

#### Scenario: 文件过大

- **WHEN** `CLAUDE.md` 超过读取大小上限
- **THEN** 系统截断内容或跳过注入，并记录日志

#### Scenario: 读取失败

- **WHEN** `CLAUDE.md` 读取抛出异常（如权限错误）
- **THEN** 系统不注入项目规范，会话正常运行，错误被记录到日志

### Requirement: 每次运行读取最新内容

系统 SHALL 在每次 Agent 会话运行时（构建系统提示词时）重新读取项目规范文件，确保使用用户最新修改的内容。

#### Scenario: 修改规范后新会话生效

- **WHEN** 用户在两次会话之间修改了 `CLAUDE.md`
- **THEN** 下一次会话构建的系统提示词包含修改后的内容

