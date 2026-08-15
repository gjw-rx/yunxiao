## Context

当前来源枚举为 `none | claude | trae`。生态 Skill 在扩展侧按来源串行重载；AgentLoop 在构建每次会话的系统提示词时，按同一来源选择 Claude 项目规范或 Trae 规则。Claude 规则加载器当前把 `AGENTS.md` 当作 `CLAUDE.md` 的回退，无法表达 Agent 生态下“只采用 `AGENTS.md`”的语义。

OpenCode 将环境规则抽象为带来源路径的系统上下文：全局 `AGENTS.md` 加上从当前目录向工作区根发现的 `AGENTS.md`，规则变化会替换此前加载的环境规则。Hermes 则把工作区规则置于按会话复用的 context 层，技能索引置于可刷新的 volatile 层，以兼顾规则一致性和提示词缓存。云效 Agent 不需要复制二者的多层扫描或缓存机制，但需要让所选生态的 Skill 和规则在同一来源决策下保持一致。

## Goals / Non-Goals

**Goals:**

- 提供互斥的 `agent` 生态来源。
- 在 `agent` 来源下加载全局 `~/.agents/skills`，同时保留现有显式目录优先和同名去重。
- 将当前工作区根目录的 `AGENTS.md` 作为 Agent 项目规则，以具名段落注入系统提示词。
- 让来源切换、运行时刷新与测试覆盖遵循现有 Claude/Trae 流程。

**Non-Goals:**

- 不扫描工作区 `.agents/skills`、子目录或父级目录中的 `AGENTS.md`。
- 不读取 `.agents` 下除 `skills` 以外的内容，不同步命令、MCP、配置或会话数据。
- 不改变 Claude、Trae、显式 Skill 目录的优先级及默认来源。
- 不在本变更中引入文件监听、跨会话缓存或递归规则合并。

## Decisions

### 1. 将 `agent` 作为独立来源枚举，而非扩展 Claude 回退规则

`SyncSource` 扩展为 `none | claude | trae | agent`；加载 Skill 和系统规则都从同一个来源值派生。

原因：`AGENTS.md` 在 Claude 来源中仅是 `CLAUDE.md` 缺失时的兼容回退；将其重用于 Agent 来源会掩盖规则选择，也无法保证 Skill 来源与规则来源匹配。独立枚举能沿用现有互斥和串行重载机制，改动最小。

备选方案是在 Claude 来源中始终同时读取 `AGENTS.md`。该方案会改变现有 Claude 语义并可能重复或冲突，因此不采用。

### 2. Agent Skill 仅使用全局 `~/.agents/skills`

扩展侧在 `agent` 来源下将 `os.homedir()/.agents/skills` 加入生态目录列表；先保留已加载的显式工作区目录，再加载该全局目录，重复名称仅补缺。

原因：用户明确要求全局 `.agents`，并且这是最小、可预测的范围。工作区 Skill 继续由现有显式目录配置管理，避免在一个来源下引入未经请求的第二个项目约定。

### 3. Agent 规则使用单独加载路径并显式标注来源

新增只接受工作区根 `AGENTS.md` 的加载入口（或为现有加载器增加明确的候选策略），并在系统提示词中输出 `<agent_project_rules>` 段及来源。`agent` 来源仅传入该规则，`claude` 继续保留 `CLAUDE.md → AGENTS.md` 逻辑，`trae` 保持现状。

原因：避免一个泛化的加载器在调用点隐式决定规则优先级；提示词段标签与日志共同提供可追踪性。该边界借鉴 OpenCode 的“来源路径 + 原子替换”思路，同时符合现有单次会话重建提示词的结构。

备选方案是复用 `<project_rules>` 段，但该段的来源语义已属于 Claude 兼容路径；独立段落更利于调试和断言。

### 4. 刷新边界保持现有模型

切换来源后通过既有串行同步队列更新 Skill 注册表、斜杠菜单和设置页快照；`AGENTS.md` 在每次 AgentLoop 构建系统提示词时重新读取，因此下一次运行使用最新文本。

原因：这既保证 Skill 状态不会交错，也避免长期持有过期项目规则；无需增加监听器或修改会话存储。

## Risks / Trade-offs

- [全局 `.agents/skills` 不存在或不可读] → 记录包含来源与路径的日志并静默跳过，插件和其他来源继续工作。
- [规则文件过大或不可读] → 复用项目规则的大小限制与降级策略，不阻断会话。
- [不同生态同名 Skill 的行为不易理解] → 保持并测试“显式目录优先、生态目录补缺”的既有规则，并在设置页显示来源路径。
- [用户期望递归或父级 `AGENTS.md`] → 本期明确限于工作区根；后续若需要层级规则，可单独设计合并顺序与上下文预算。

## Migration Plan

1. 保留存储中的既有 `none`、`claude`、`trae` 值与默认 `claude` 行为。
2. 发布后用户主动选择 `agent` 才加载 `~/.agents/skills` 和工作区 `AGENTS.md`。
3. 若出现问题，切回任一既有来源即可卸载 Agent 生态 Skill；无需数据迁移或外部回滚。

## Open Questions

- 无。全局目录按用户主目录下的 `.agents/skills` 解释，项目规则仅为当前工作区根 `AGENTS.md`。
