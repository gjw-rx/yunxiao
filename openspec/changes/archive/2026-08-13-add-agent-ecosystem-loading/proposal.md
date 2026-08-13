## Why

当前“生态配置来源”仅支持 Claude、Trae 和不加载。使用 Codex Agent 生态的用户无法直接复用全局 `.agents/skills`，且工作区 `AGENTS.md` 只有作为 Claude 规则的回退时才会注入，无法明确表达 Agent 生态的项目约束。

新增独立的 `agent` 来源，使 Skill 发现和项目规则注入在同一次来源选择下保持一致，并与 OpenCode、Hermes Agent 的“规则作为可追踪系统上下文”做法对齐。

## What Changes

- 在生态配置来源单选中新增 `agent` 选项；该选项与 `claude`、`trae`、`none` 互斥。
- 当来源为 `agent` 时，加载全局 `<用户主目录>/.agents/skills` 下的标准 Skill；沿用现有显式目录优先及同名不覆盖规则。
- 当来源为 `agent` 时，仅读取当前工作区根目录的 `AGENTS.md`，将其作为 Agent 项目规则注入系统提示词；不以 `CLAUDE.md` 作为该来源的候选规则。
- 来源切换后串行刷新生态 Skill；后续会话构建系统提示词时按新来源读取最新项目规则，并记录可定位日志。
- 为新增来源、Skill 加载与规则注入补充单元测试，并更新设置页来源展示与相关类型契约。

## Capabilities

### New Capabilities

- `agent-config-sync`: 以 `agent` 为生态来源时发现全局 `.agents/skills`，并将工作区根 `AGENTS.md` 作为 Agent 项目规则注入系统提示词。

### Modified Capabilities

- `sync-config-source`: 扩展来源枚举、默认值校验与来源切换的互斥同步语义。
- `skill-settings-management`: 设置页展示并可选择 Agent 生态来源，刷新后的 Skill 快照反映该来源。
- `project-rules-injection`: 明确 Agent 来源下的规则选择为工作区根 `AGENTS.md`，与 Claude 来源的 `CLAUDE.md` 优先逻辑隔离。

## Impact

- 受影响代码：`src/config/syncConfig.ts`、`src/extension.ts`、`src/agent/agentLoop.ts`、`src/agent/projectRules.ts`、`src/agent/systemPrompt.ts`、设置页与 Webview 协议、对应测试。
- 不新增外部依赖、配置项或网络访问；来源选择仍保存在现有私有存储中。
- 参考实现：OpenCode 将全局及向上发现的 `AGENTS.md` 建模为系统上下文并标注来源；Hermes 将工作区规则放在稳定 context 层、技能索引放在可刷新的 volatile 层。本变更在现有架构中采用等价的来源分层和刷新边界。
