## ADDED Requirements

### Requirement: 来源为 agent 时同步全局 Agent Skill
系统 SHALL 在配置来源为 `agent` 时从用户主目录下的 `~/.agents/skills` 加载符合现有 Skill 协议的 Skill。目录不存在、不是目录或不可读时 SHALL 跳过且不影响插件激活。系统 SHALL NOT 在该来源下读取 `.agents` 的其他内容，也 SHALL NOT 因此扫描工作区 `.agents/skills`。

#### Scenario: 全局 Agent Skill 可用
- **WHEN** 配置来源为 `agent`，且 `~/.agents/skills/plan/SKILL.md` 存在并有效
- **THEN** 系统将 `plan` 注册为可用 Skill，并保留其来源路径

#### Scenario: 全局目录不存在
- **WHEN** 配置来源为 `agent`，且 `~/.agents/skills` 不存在
- **THEN** 系统记录可定位日志、跳过该目录，插件和其他已加载 Skill 正常工作

### Requirement: Agent Skill 遵循既有优先级与切换隔离
系统 SHALL 先保留显式配置目录中已注册的 Skill，再加载 Agent 生态 Skill；同名 Agent Skill SHALL NOT 覆盖已注册 Skill。切换离开 `agent` 时，系统 SHALL 仅卸载该来源注册的生态 Skill，并保持显式目录 Skill 不变。

#### Scenario: 显式目录同名 Skill 优先
- **WHEN** 显式配置目录和 `~/.agents/skills` 都包含同名 `plan` Skill，且来源为 `agent`
- **THEN** 注册表保留显式目录中的 `plan`，跳过 Agent 目录中的同名 Skill 并记录日志

#### Scenario: 切换离开 Agent 来源
- **WHEN** 用户将来源从 `agent` 切换为 `claude`、`trae` 或 `none`
- **THEN** Agent 生态 Skill 被卸载，新的来源 Skill 按现有串行同步流程加载

### Requirement: Agent 项目规则注入
系统 SHALL 在来源为 `agent` 时仅读取当前工作区根目录的 `AGENTS.md`，并在系统提示词中以 `<agent_project_rules>` 段注入其内容、来源文件名和“开发工作必须遵循”的声明。系统 SHALL NOT 将 `CLAUDE.md` 作为该来源的规则候选。

#### Scenario: 工作区 Agent 规则进入系统提示词
- **WHEN** 配置来源为 `agent`，工作区根目录存在 `AGENTS.md` 且 Agent 会话运行
- **THEN** 系统提示词包含 `<agent_project_rules>` 段及 `AGENTS.md` 的最新内容，不包含 Claude 或 Trae 的项目规则段

#### Scenario: Agent 规则不存在
- **WHEN** 配置来源为 `agent`，工作区根目录不存在 `AGENTS.md`
- **THEN** 系统不注入 Agent 项目规则，仍正常构建系统提示词与处理会话

### Requirement: Agent 规则安全降级与新鲜度
系统 SHALL 在每次 Agent 会话运行、构建系统提示词时重新读取工作区 `AGENTS.md`。读取 SHALL 受现有项目规则大小上限保护；文件过大或读取失败时系统 SHALL 不注入规则、记录日志且不中断会话。

#### Scenario: 修改后下一次会话生效
- **WHEN** 用户在两次 Agent 会话运行之间修改工作区根的 `AGENTS.md`
- **THEN** 下一次构建的 `<agent_project_rules>` 段包含修改后的内容
