# claude-config-sync Specification

## Purpose
本能力新增「同步CLAUDE配置」开关（`yunxiaoAgent.claude.syncEnabled`）：开启后读取 Claude 目录中的 SKILL 部分（用户级 `~/.claude/skills` 与项目级 `.claude/skills`）注册进 skill 注册表，供斜杠菜单与 skill 工具使用。本期仅同步 SKILL 与读取项目 `CLAUDE.md`（后者由项目规范注入能力消费）。

## ADDED Requirements

### Requirement: 新增「同步CLAUDE配置」配置项

系统 SHALL 在 VSCode 配置（`yunxiaoAgent.claude.syncEnabled`，显示名「同步CLAUDE配置」）中提供布尔开关，默认关闭。开启后系统 SHALL 同步 Claude 目录中的 SKILL；关闭时 SHALL 不加载任何 Claude 目录内容。

#### Scenario: 默认关闭

- **WHEN** 用户未修改「同步CLAUDE配置」配置
- **THEN** 配置值为 false，系统不加载任何 `~/.claude` 或 `.claude` 目录内容

#### Scenario: 开启后同步 SKILL

- **WHEN** 用户开启「同步CLAUDE配置」且 `~/.claude/skills` 或项目 `.claude/skills` 中存在 skill 文件
- **THEN** 这些 SKILL 被注册进 skill 注册表，并出现在斜杠菜单「SKILL与命令」分组

### Requirement: 同步 Claude SKILL 目录

开启同步后，系统 SHALL 从两个目录加载 SKILL：用户级 `~/.claude/skills`（`os.homedir()` 拼接）与项目级 `<workspaceRoot>/.claude/skills`。目录不存在或不可读时 SHALL 静默跳过（返回空列表），不中断插件激活。

#### Scenario: 目录不存在

- **WHEN** `~/.claude/skills` 目录不存在，且同步已开启
- **THEN** 系统跳过该目录，不报错，其余目录正常加载

#### Scenario: 用户级与项目级目录同时存在

- **WHEN** `~/.claude/skills` 与项目 `.claude/skills` 均有 skill 文件，且同步已开启
- **THEN** 两处 SKILL 均被注册进 skill 注册表

### Requirement: 去重与优先级

显式配置的 skill 目录（`yunxiaoAgent.skills.directories`）SHALL 先于 Claude 目录加载；当 Claude 目录中的 skill 与已注册 skill 同名时，SHALL 不覆盖已有注册（显式配置优先，Claude 目录仅补缺）。

#### Scenario: 同名 skill 不覆盖

- **WHEN** `.vscode/skills/plan.md` 与 `.claude/skills/plan.md` 均存在，且同步已开启
- **THEN** 注册表中 `plan` 为 `.vscode/skills` 版本，Claude 版本被跳过

### Requirement: 配置变更热生效

「同步CLAUDE配置」值发生变化时，系统 SHALL 检测到配置变更（`affectsConfiguration`），重新执行 skill 目录加载，并刷新斜杠菜单命令数据。

#### Scenario: 关闭同步后移除 Claude skill

- **WHEN** 用户从开启状态关闭「同步CLAUDE配置」
- **THEN** 注册表中来自 Claude 目录的 skill 被移除，斜杠菜单同步刷新

#### Scenario: 开启同步后新增 Claude skill

- **WHEN** 用户从关闭状态开启「同步CLAUDE配置」
- **THEN** 注册表加载 Claude 目录 skill，斜杠菜单同步刷新

### Requirement: 本期同步范围限制

系统 SHALL 仅同步 Claude 目录中的 SKILL（`skills/` 子目录下的 `*.md`）与读取项目根 `CLAUDE.md`。SHALL NOT 读取或同步 `commands`、`settings.json`、MCP 配置、会话历史等其他 Claude 目录内容。

#### Scenario: 忽略非 SKILL 内容

- **WHEN** `~/.claude` 下存在 `settings.json`、`commands/` 等非 skills 内容，且同步已开启
- **THEN** 系统仅加载 `skills/` 下的 SKILL，忽略其他内容
