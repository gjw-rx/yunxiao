# trae-config-sync Specification

## Purpose
本能力新增「同步TRAE配置」开关（`yunxiaoAgent.trae.syncEnabled`）：开启后读取 Trae 目录中的 SKILL（用户级 `~/.trae/skills`、`~/.trae-cn/skills` 与项目级 `.trae/skills`、`.trae-cn/skills`）注册进 skill 注册表，供斜杠菜单与 skill 工具使用。本期仅同步 SKILL，不读取 `skill-config.json`、MCP 配置等其他 Trae 目录内容。

## ADDED Requirements

### Requirement: 同步开关

系统 SHALL 在 VSCode 配置（`yunxiaoAgent.trae.syncEnabled`，显示名「同步TRAE配置」）中提供布尔开关，默认关闭。开启后系统 SHALL 同步 Trae 目录中的 SKILL；关闭时 SHALL 不加载任何 Trae 目录内容。

#### Scenario: 默认关闭

- **WHEN** 用户未修改「同步TRAE配置」
- **THEN** 配置值为 false，系统不加载任何 `~/.trae`、`~/.trae-cn`、`.trae`、`.trae-cn` 目录内容

#### Scenario: 关闭时卸载

- **WHEN** 用户将「同步TRAE配置」从 true 改为 false
- **THEN** 注册表中来自 Trae 目录的 skill 被移除，斜杠菜单同步刷新

### Requirement: 同步 Trae SKILL 目录

开启同步后，系统 SHALL 从四个目录加载 SKILL：用户级 `~/.trae/skills`、`~/.trae-cn/skills`（`os.homedir()` 拼接）与项目级 `<workspaceRoot>/.trae/skills`、`<workspaceRoot>/.trae-cn/skills`。目录不存在或不可读时 SHALL 静默跳过（返回空列表），不中断插件激活。

#### Scenario: 目录存在且含标准 SKILL 结构

- **WHEN** `~/.trae/skills` 或项目 `.trae/skills` 中存在 `<skill-name>/SKILL.md`（Anthropic Agent Skills 标准结构），且同步已开启
- **THEN** 这些 SKILL 被加载注册，供斜杠菜单与 skill 工具使用

#### Scenario: 目录不存在

- **WHEN** `~/.trae/skills` 与项目 `.trae-cn/skills` 等目录均不存在，且同步已开启
- **THEN** 系统静默跳过，不产生错误，插件正常激活

### Requirement: 同名 SKILL 去重（显式目录优先）

显式配置的 skill 目录（`yunxiaoAgent.skills.directories`）SHALL 先于 Claude 目录与 Trae 目录加载；当 Trae 目录中的 skill 与已注册 skill（来自显式目录或 Claude 目录）同名时，SHALL 不覆盖已有注册（仅补缺）。

#### Scenario: 与显式目录 skill 同名

- **WHEN** `.vscode/skills/plan.md` 与 `.trae/skills/plan/SKILL.md` 均存在，且同步已开启
- **THEN** 注册表中 `plan` 为 `.vscode/skills` 版本，Trae 版本被跳过并记录日志

#### Scenario: 与 Claude 目录 skill 同名

- **WHEN** `.claude/skills/plan/SKILL.md` 与 `.trae/skills/plan/SKILL.md` 均存在，且两项同步均已开启
- **THEN** 注册表中 `plan` 为 Claude 目录版本，Trae 版本被跳过并记录日志

### Requirement: 配置变更热生效

系统 SHALL 监听 `yunxiaoAgent.trae.*` 配置变更：开启时加载 Trae 目录 skill，关闭时移除本次同步注册的 Trae skill，并在变更后刷新斜杠命令数据。刷新失败 SHALL 不影响其他功能。

#### Scenario: 开启同步后新增 Trae skill

- **WHEN** 用户开启「同步TRAE配置」且 Trae 目录中存在 skill 文件
- **THEN** 注册表加载 Trae 目录 skill，斜杠菜单同步刷新

#### Scenario: 关闭同步后移除 Trae skill

- **WHEN** 用户关闭「同步TRAE配置」
- **THEN** 注册表中来自 Trae 目录的 skill 被移除，斜杠菜单同步刷新；来自显式目录与 Claude 目录的 skill 不受影响

### Requirement: 同步范围限制

系统 SHALL 仅同步 Trae 目录中的 SKILL（`skills/` 子目录下的 `SKILL.md`）。SHALL NOT 读取或同步 `skill-config.json`、MCP 配置、会话历史等其他 Trae 目录内容。

#### Scenario: Trae 目录含非 SKILL 内容

- **WHEN** `.trae` 下存在 `skill-config.json`、`mcp.json` 等非 SKILL 内容，且同步已开启
- **THEN** 系统不读取或同步这些内容
