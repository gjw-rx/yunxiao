## ADDED Requirements

### Requirement: Agent 来源的工作区 AGENTS.md 解析
系统 SHALL 提供与 Claude 项目规则解析隔离的 Agent 规则解析：仅在配置来源为 `agent` 时读取当前工作区根目录 `AGENTS.md`。该解析 SHALL 不读取 `CLAUDE.md`，且 SHALL 不向父目录或子目录搜索规则文件。

#### Scenario: Agent 来源只选择工作区根 AGENTS.md
- **WHEN** 配置来源为 `agent`，工作区根同时存在 `CLAUDE.md` 和 `AGENTS.md`
- **THEN** 系统仅将 `AGENTS.md` 作为 Agent 项目规则，不读取 `CLAUDE.md`

#### Scenario: Agent 来源不合并层级规则
- **WHEN** 配置来源为 `agent`，工作区父目录或子目录也存在 `AGENTS.md`
- **THEN** 系统不读取这些文件，仅考虑当前工作区根目录的 `AGENTS.md`
