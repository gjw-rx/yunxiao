## MODIFIED Requirements

### Requirement: 来源为 claude 时同步
系统 SHALL 在配置来源为 `claude` 时同步 Claude 目录中的 SKILL；来源为 `none` 或 `trae` 时 SHALL 不加载任何 Claude 目录内容。默认配置来源 MUST 为 `claude`。来源切换为 `claude` 时加载，切换离开 `claude` 时卸载本次注册的 Claude skill。

#### Scenario: 默认加载 Claude Skill
- **WHEN** 用户未显式修改配置来源
- **THEN** 系统以 `claude` 作为来源并加载可用的 `~/.claude/skills` 和项目 `.claude/skills`

#### Scenario: 切换离开 claude 时卸载
- **WHEN** 配置来源从 `claude` 改为 `trae` 或 `none`
- **THEN** 注册表中来自 Claude 目录的 skill 被移除，斜杠菜单同步刷新

### Requirement: 去重与优先级
项目 `.claude/skills` SHALL 作为默认项目 Skill 目录并先于用户级 Claude 目录加载；当后续目录中的 skill 与已注册 skill 同名时，SHALL 不覆盖已有注册。旧的显式 `yunxiaoAgent.skills.directories` 配置 SHALL 不再参与默认加载。

#### Scenario: 项目 Skill 优先
- **WHEN** 项目 `.claude/skills/plan/SKILL.md` 与 `~/.claude/skills/plan/SKILL.md` 均存在
- **THEN** 注册表中 `plan` 为项目 `.claude/skills` 版本，用户级版本被跳过
