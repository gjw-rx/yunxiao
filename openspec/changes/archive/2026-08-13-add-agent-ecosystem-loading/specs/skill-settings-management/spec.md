## ADDED Requirements

### Requirement: 设置页提供 Agent 生态来源
Skill 设置页 SHALL 将 `agent` 作为生态配置来源单选项展示，并保持与 `none`、`claude`、`trae` 的互斥选择行为。切换成功后的设置页 Skill 快照 SHALL 反映当前注册表中来自 Agent 目录的 Skill 及其来源路径。

#### Scenario: 从设置页切换到 Agent
- **WHEN** 用户在 Skill 设置页面选择 `agent`
- **THEN** 页面在同步完成后显示 Agent 来源为当前选择，并展示新加载的 Skill 或明确空状态
