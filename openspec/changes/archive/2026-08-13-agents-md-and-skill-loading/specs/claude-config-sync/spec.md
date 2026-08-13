# claude-config-sync Specification (delta)

## MODIFIED Requirements

### Requirement: 来源为 claude 时同步

系统 SHALL 默认加载 Claude 生态 Skill：用户级 `~/.claude/skills`（`os.homedir()` 拼接）与项目级 `<workspaceRoot>/.claude/skills`。默认加载 SHALL 与「配置来源」解耦：配置来源为 `none` 或 `trae` 时仍加载 Claude Skill；配置来源切换或 Skill 安装刷新时 SHALL NOT 卸载默认加载的 Claude Skill。配置来源为 `trae` 时 Trae Skill 照旧按既有逻辑加载（两套 Skill 并存）。

#### Scenario: 默认加载 Claude Skill

- **WHEN** 用户未显式修改配置来源
- **THEN** 系统加载可用的 `~/.claude/skills` 和项目 `.claude/skills`

#### Scenario: 来源为 none 仍加载

- **WHEN** 配置来源为 `none`
- **THEN** 系统仍加载用户级与项目级 Claude Skill

#### Scenario: 切换来源不卸载

- **WHEN** 配置来源从 `none` 切换为 `trae`
- **THEN** 注册表中 Claude 生态 Skill 保留，Trae Skill 按既有逻辑加载
