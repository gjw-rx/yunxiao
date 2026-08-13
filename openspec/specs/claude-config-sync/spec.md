# claude-config-sync Specification

## Purpose
TBD - created by archiving change slash-menu-and-claude-integration. Update Purpose after archive.
## Requirements
### Requirement: 来源为 claude 时同步
系统 SHALL 在配置来源为 `claude` 时同步 Claude 目录中的 SKILL；来源为 `none` 或 `trae` 时 SHALL 不加载任何 Claude 目录内容。默认配置来源 MUST 为 `claude`。来源切换为 `claude` 时加载，切换离开 `claude` 时卸载本次注册的 Claude skill。

#### Scenario: 默认加载 Claude Skill
- **WHEN** 用户未显式修改配置来源
- **THEN** 系统以 `claude` 作为来源并加载可用的 `~/.claude/skills` 和项目 `.claude/skills`

#### Scenario: 切换离开 claude 时卸载
- **WHEN** 配置来源从 `claude` 改为 `trae` 或 `none`
- **THEN** 注册表中来自 Claude 目录的 skill 被移除，斜杠菜单同步刷新

### Requirement: 同步 Claude SKILL 目录
来源为 `claude` 时，系统 SHALL 从两个目录加载 SKILL：用户级 `~/.claude/skills`（`os.homedir()` 拼接）与项目级 `<workspaceRoot>/.claude/skills`。目录不存在或不可读时 SHALL 静默跳过（返回空列表），不中断插件激活。

#### Scenario: 目录不存在
- **WHEN** `~/.claude/skills` 目录不存在，且来源为 `claude`
- **THEN** 系统跳过该目录，不报错，其余目录正常加载

#### Scenario: 用户级与项目级目录同时存在
- **WHEN** `~/.claude/skills` 与项目 `.claude/skills` 均有 skill 文件，且来源为 `claude`
- **THEN** 两处 SKILL 均被注册进 skill 注册表

### Requirement: 去重与优先级
项目 `.claude/skills` SHALL 作为默认项目 Skill 目录并先于用户级 Claude 目录加载；当后续目录中的 skill 与已注册 skill 同名时，SHALL 不覆盖已有注册。旧的显式 `yunxiaoAgent.skills.directories` 配置 SHALL 不再参与默认加载。

#### Scenario: 项目 Skill 优先
- **WHEN** 项目 `.claude/skills/plan/SKILL.md` 与 `~/.claude/skills/plan/SKILL.md` 均存在
- **THEN** 注册表中 `plan` 为项目 `.claude/skills` 版本，用户级版本被跳过

### Requirement: 本期同步范围限制
系统 SHALL 仅同步 Claude 目录中的 SKILL（`skills/` 子目录下的 `*.md`）。SHALL NOT 读取或同步 `commands`、`settings.json`、MCP 配置、会话历史等其他 Claude 目录内容。

#### Scenario: 忽略非 SKILL 内容
- **WHEN** `~/.claude` 下存在 `settings.json`、`commands/` 等非 skills 内容，且来源为 `claude`
- **THEN** 系统仅加载 `skills/` 下的 SKILL，忽略其他内容

