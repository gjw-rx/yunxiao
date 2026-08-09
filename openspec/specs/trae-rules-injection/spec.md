# trae-rules-injection Specification

## Purpose
本能力将项目 Trae 规则目录（`.trae/rules` 与 `.trae-cn/rules`，递归 ≤3 层）中的 Markdown 规则文件作为「Trae 项目规则」注入系统提示词，并声明开发工作须遵循，确保 Agent 行为符合项目在 Trae 中沉淀的约定。注入受「配置来源」（`yunxiaoAgent.sync.source`，见 [[sync-config-source]]）控制：仅当来源为 `trae` 时注入；来源为 `claude` 时改由 CLAUDE.md/AGENTS.md 项目规范（`<project_rules>` 段）注入，避免两套规则重复。

## ADDED Requirements

### Requirement: Trae 规则文件解析
系统 SHALL 在每次会话运行时从项目根解析 Trae 规则：扫描 `<workspaceRoot>/.trae/rules` 与 `<workspaceRoot>/.trae-cn/rules` 目录（递归 ≤3 层），收集全部 `*.md` 文件；目录不存在或为空时 SHALL 返回空（不注入）。

#### Scenario: 存在规则文件
- **WHEN** 项目 `.trae/rules` 下存在 `project_rules.md`（含子目录如 `git/rules.md`）
- **THEN** 系统收集全部规则文件内容，拼接后注入系统提示词

#### Scenario: 规则目录不存在
- **WHEN** 项目既无 `.trae/rules` 也无 `.trae-cn/rules`
- **THEN** 系统不注入 Trae 规则，系统提示词其余部分正常构建

### Requirement: 注入系统提示词并声明遵循
系统 SHALL 将 Trae 规则以「Trae 项目规则」身份注入 `buildSystemPrompt` 产出的系统提示词，并包含明确声明：以下内容为 Trae 项目规则，开发工作须遵循。注入内容 SHALL 标注来源文件路径列表。系统提示词中 SHALL 同时保留原有的 agent 提示词、环境信息与可用 skill 段落。

#### Scenario: Trae 规则进入系统提示词
- **WHEN** 配置来源为 `trae`、项目存在 `.trae/rules` 规则文件且 Agent 会话启动
- **THEN** 系统提示词包含 `<trae_rules>` 段落，段落内声明「Trae 项目规则」并附来源路径列表与规则内容

#### Scenario: 来源非 trae 时不注入
- **WHEN** 配置来源为 `none` 或 `claude`，项目存在 `.trae/rules` 规则文件
- **THEN** 系统提示词不包含 `<trae_rules>` 段落

#### Scenario: 与 CLAUDE.md 二选一
- **WHEN** 配置来源为 `claude`，项目同时存在 `CLAUDE.md` 与 `.trae/rules`
- **THEN** 系统提示词仅包含 `<project_rules>`（CLAUDE.md 内容），不包含 `<trae_rules>` 段落，避免重复约束

### Requirement: 读取安全与失败降级
读取 Trae 规则文件 SHALL 遵循文件读取安全策略。全部规则内容合计超过大小上限时 SHALL 跳过注入；单个文件读取失败 SHALL 静默跳过该文件（不影响其余文件），整体失败 SHALL 不注入且不影响对话主流程，并记录日志。

#### Scenario: 规则合计过大
- **WHEN** `.trae/rules` 下所有规则文件合计超过大小上限（64KB）
- **THEN** 系统跳过注入并记录日志

#### Scenario: 部分文件读取失败
- **WHEN** `.trae/rules` 下某文件读取抛出异常（如权限错误）
- **THEN** 系统跳过该文件继续处理其余文件；全部失败时会话正常运行，错误被记录到日志

### Requirement: 每次运行读取最新内容
系统 SHALL 在每次 Agent 会话运行时（构建系统提示词时）重新读取 Trae 规则文件，确保使用用户最新修改的内容。

#### Scenario: 修改规则后新会话生效
- **WHEN** 用户在两次会话之间修改了 `.trae/rules` 下某规则文件
- **THEN** 下一次会话构建的系统提示词包含修改后的内容
