# claude-config-sync Specification

## Purpose
定义 Claude 生态配置（SKILL）的同步机制：用户级 `~/.claude/skills` 与项目级 `.claude/skills` 为常驻默认加载（与「配置来源」解耦、切源不卸载），包含目录扫描、去重优先级与同步范围限制。
## Requirements
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

### Requirement: 同步 Claude SKILL 目录
系统 SHALL 从两个目录加载 SKILL：用户级 `~/.claude/skills`（`os.homedir()` 拼接）与项目级 `<workspaceRoot>/.claude/skills`。目录不存在或不可读时 SHALL 静默跳过（返回空列表），不中断插件激活。

#### Scenario: 目录不存在
- **WHEN** `~/.claude/skills` 目录不存在
- **THEN** 系统跳过该目录，不报错，其余目录正常加载

#### Scenario: 用户级与项目级目录同时存在
- **WHEN** `~/.claude/skills` 与项目 `.claude/skills` 均有 skill 文件
- **THEN** 两处 SKILL 均被注册进 skill 注册表

### Requirement: 去重与优先级
项目 `.claude/skills` SHALL 作为默认项目 Skill 目录并先于用户级 Claude 目录加载；当后续目录中的 skill 与已注册 skill 同名时，SHALL 不覆盖已有注册。旧的显式 `yunxiaoAgent.skills.directories` 配置 SHALL 不再参与默认加载。

#### Scenario: 项目 Skill 优先
- **WHEN** 项目 `.claude/skills/plan/SKILL.md` 与 `~/.claude/skills/plan/SKILL.md` 均存在
- **THEN** 注册表中 `plan` 为项目 `.claude/skills` 版本，用户级版本被跳过

### Requirement: 本期同步范围限制
系统 SHALL 仅同步 Claude 目录中的 SKILL（`skills/` 子目录下的 `*.md`）。SHALL NOT 读取或同步 `commands`、`settings.json`、MCP 配置、会话历史等其他 Claude 目录内容。

#### Scenario: 忽略非 SKILL 内容
- **WHEN** `~/.claude` 下存在 `settings.json`、`commands/` 等非 skills 内容
- **THEN** 系统仅加载 `skills/` 下的 SKILL，忽略其他内容

