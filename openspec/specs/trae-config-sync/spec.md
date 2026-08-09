# trae-config-sync Specification

## Purpose
本能力在「配置来源」（`yunxiaoAgent.sync.source`，见 [[sync-config-source]]）为 `trae` 时，读取 Trae 目录中的 SKILL（用户级 `~/.trae/skills`、`~/.trae-cn/skills` 与项目级 `.trae/skills`、`.trae-cn/skills`）注册进 skill 注册表，供斜杠菜单与 skill 工具使用。仅当配置来源为 `trae` 时生效；来源为 `none` 或 `claude` 时不加载任何 Trae 目录内容。本期仅同步 SKILL，不读取 `skill-config.json`、MCP 配置等其他 Trae 目录内容。

## ADDED Requirements

### Requirement: 来源为 trae 时同步
系统 SHALL 在配置来源为 `trae` 时同步 Trae 目录中的 SKILL；来源为 `none` 或 `claude` 时 SHALL 不加载任何 Trae 目录内容。来源切换为 `trae` 时加载，切换离开 `trae` 时卸载本次注册的 Trae skill。

#### Scenario: 默认不加载
- **WHEN** 配置来源为 `none`（默认）
- **THEN** 系统不加载任何 `~/.trae`、`~/.trae-cn`、`.trae`、`.trae-cn` 目录内容

#### Scenario: 切换离开 trae 时卸载
- **WHEN** 配置来源从 `trae` 改为 `claude` 或 `none`
- **THEN** 注册表中来自 Trae 目录的 skill 被移除，斜杠菜单同步刷新

### Requirement: 同步 Trae SKILL 目录
来源为 `trae` 时，系统 SHALL 从四个目录加载 SKILL：用户级 `~/.trae/skills`、`~/.trae-cn/skills`（`os.homedir()` 拼接）与项目级 `<workspaceRoot>/.trae/skills`、`<workspaceRoot>/.trae-cn/skills`。目录不存在或不可读时 SHALL 静默跳过（返回空列表），不中断插件激活。

#### Scenario: 目录存在且含标准 SKILL 结构
- **WHEN** `~/.trae/skills` 或项目 `.trae/skills` 中存在 `<skill-name>/SKILL.md`（Anthropic Agent Skills 标准结构），且来源为 `trae`
- **THEN** 这些 SKILL 被加载注册，供斜杠菜单与 skill 工具使用

#### Scenario: 目录不存在
- **WHEN** `~/.trae/skills` 与项目 `.trae-cn/skills` 等目录均不存在，且来源为 `trae`
- **THEN** 系统静默跳过，不产生错误，插件正常激活

### Requirement: 同名 SKILL 去重（显式目录优先）
显式配置的 skill 目录（`yunxiaoAgent.skills.directories`）SHALL 先于生态目录加载；当 Trae 目录中的 skill 与已注册 skill 同名时，SHALL 不覆盖已有注册（仅补缺）。

#### Scenario: 与显式目录 skill 同名
- **WHEN** `.vscode/skills/plan.md` 与 `.trae/skills/plan/SKILL.md` 均存在，且来源为 `trae`
- **THEN** 注册表中 `plan` 为 `.vscode/skills` 版本，Trae 版本被跳过并记录日志

### Requirement: 同步范围限制
系统 SHALL 仅同步 Trae 目录中的 SKILL（`skills/` 子目录下的 `SKILL.md`）。SHALL NOT 读取或同步 `skill-config.json`、MCP 配置、会话历史等其他 Trae 目录内容。

#### Scenario: Trae 目录含非 SKILL 内容
- **WHEN** `.trae` 下存在 `skill-config.json`、`mcp.json` 等非 SKILL 内容，且来源为 `trae`
- **THEN** 系统不读取或同步这些内容
