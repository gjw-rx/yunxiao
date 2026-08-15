# sync-config-source Specification

## Purpose
本能力提供「配置来源」单选配置（`yunxiaoAgent.sync.source`），将 Claude 与 Trae 两套生态配置（SKILL 同步 + 项目规则注入）收敛为三选一：`none` / `claude` / `trae`。避免两套配置同时开启导致系统提示词重复出现相关约束信息、skill 叠加加载。替换原有的两个布尔开关（`yunxiaoAgent.claude.syncEnabled`、`yunxiaoAgent.trae.syncEnabled`）。
## Requirements
### Requirement: 配置来源单选
系统 SHALL 在插件配置页面中提供配置来源的枚举单选，取值 `none` / `claude` / `trae` / `agent`，默认 `claude`。`none` 表示不加载任何生态配置；`claude` 表示加载 Claude 生态；`trae` 表示加载 Trae 生态；`agent` 表示加载 Agent 生态。四值互斥，同一时刻只生效一个来源。配置值非法时 SHALL 回退默认值 `claude`。系统 SHALL NOT 通过 `yunxiaoAgent.sync.source` VS Code 配置项读写该值。

#### Scenario: 默认加载 Claude 内容
- **WHEN** 用户尚未保存配置来源
- **THEN** 配置值为 `claude`，系统加载可用 Claude Skill 目录并注入 Claude 项目规则

#### Scenario: 选择 Agent 来源
- **WHEN** 用户在设置页面选择 `agent`
- **THEN** 配置值保存为 `agent`，系统按 Agent 生态规则加载内容

#### Scenario: 非法值回退
- **WHEN** 私有存储中的配置来源为枚举外的值
- **THEN** 系统按 `claude` 处理并记录日志

### Requirement: 生态 SKILL 同步二选一
系统 SHALL 仅按当前配置来源同步对应生态目录的 SKILL：`claude` 时从 `~/.claude/skills` 与项目 `.claude/skills` 加载；`trae` 时从 `~/.trae/skills`、`~/.trae-cn/skills` 与项目 `.trae/skills`、`.trae-cn/skills` 加载；`agent` 时从 `~/.agents/skills` 加载。目录不存在或不可读时 SHALL 静默跳过。切换来源时 SHALL 先卸载上次来源注册的 skill，再加载新来源，同一时刻仅存在一个来源的生态 skill。显式配置目录（`yunxiaoAgent.skills.directories`）优先，生态目录同名不覆盖（仅补缺）。

#### Scenario: 切换来源卸载旧 skill
- **WHEN** 配置来源从 `claude` 切换为 `trae`
- **THEN** 注册表中来自 Claude 目录的 skill 被移除，Trae 目录 skill 被加载，斜杠菜单同步刷新

#### Scenario: 切换到 Agent 来源
- **WHEN** 配置来源从 `claude`、`trae` 或 `none` 切换为 `agent`
- **THEN** 旧来源生态 Skill 被卸载，`~/.agents/skills` 中可用 Skill 被加载，斜杠菜单同步刷新

#### Scenario: 关闭来源卸载全部生态 skill
- **WHEN** 配置来源从 `claude`、`trae` 或 `agent` 切换为 `none`
- **THEN** 注册表中来自生态目录的 skill 被移除，显式配置目录 skill 不受影响

### Requirement: 项目规则注入二选一
系统 SHALL 按当前配置来源决定注入哪一套项目规则：`claude` 时注入项目 `CLAUDE.md`（回退 `AGENTS.md`）作为 `<project_rules>`；`trae` 时注入项目 `.trae/rules` 与 `.trae-cn/rules` 作为 `<trae_rules>`；`agent` 时注入工作区根目录 `AGENTS.md` 作为 `<agent_project_rules>`；`none` 时三者均不注入。系统提示词 SHALL NOT 同时包含多套生态规则，避免重复约束。

#### Scenario: claude 来源注入 CLAUDE.md
- **WHEN** 配置来源为 `claude`，项目根存在 `CLAUDE.md`
- **THEN** 系统提示词包含 `<project_rules>` 段落，不包含 `<trae_rules>` 或 `<agent_project_rules>` 段落

#### Scenario: trae 来源注入 Trae 规则
- **WHEN** 配置来源为 `trae`，项目 `.trae/rules` 存在规则文件
- **THEN** 系统提示词包含 `<trae_rules>` 段落，不包含 `<project_rules>` 或 `<agent_project_rules>` 段落

#### Scenario: agent 来源注入 AGENTS.md
- **WHEN** 配置来源为 `agent`，工作区根存在 `AGENTS.md`
- **THEN** 系统提示词包含 `<agent_project_rules>` 段落，不包含 `<project_rules>` 或 `<trae_rules>` 段落

#### Scenario: none 来源不注入
- **WHEN** 配置来源为 `none`，项目同时存在 `CLAUDE.md`、`AGENTS.md` 与 `.trae/rules`
- **THEN** 系统提示词不包含任何生态项目规则段落

### Requirement: 配置变更热生效
系统 SHALL 监听 `yunxiaoAgent.sync.*` 配置变更：切换来源时重新执行生态 SKILL 同步并刷新斜杠命令数据。同步过程 SHALL 串行执行（变更回调排队），避免快速连续切换导致卸载/注册交错产生状态错乱；任一次同步失败 SHALL 不影响其他功能。

#### Scenario: 变更后立即生效
- **WHEN** 用户将配置来源从 `trae` 切换为 `claude` 后不重启插件
- **THEN** 生态 skill 与项目规则注入随即按新来源生效（skill 立即刷新，规则注入在下一次系统提示词构建时生效）

