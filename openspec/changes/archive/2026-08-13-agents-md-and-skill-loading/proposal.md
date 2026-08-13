# 读取 Agent 文件并默认加载 AGENTS.md 与全局/项目 Skill

## Why

当前云效 Agent 已支持项目根 `CLAUDE.md`（优先）→ `AGENTS.md`（回退）的规则注入，以及 `.claude/skills` 的 Skill 同步——但二者都绑定在「配置来源」（syncSource）上：来源为 `none` 或 `trae` 时，`AGENTS.md` 与 Claude 生态 Skill 完全不加载；且仅加载项目根一层，不支持 Claude Code 式的用户级全局记忆（`~/.claude/AGENTS.md`）。这与 Claude Code 的 Agent 文件机制（AGENTS.md 默认加载 + 用户级/项目级 Skill 默认可用）存在明显差距，导致开箱即用时缺少项目约束与可用技能。

## What Changes

- **AGENTS.md 默认加载**：项目级 `AGENTS.md` 从「CLAUDE.md 的回退项」提升为默认加载的 Agent 指令文件，不再受「配置来源」限制；同时新增用户级全局记忆 `~/.claude/AGENTS.md` 的加载。
- **CLAUDE.md 兼容保留**：`CLAUDE.md` 保持既有行为（配置来源为 `claude` 时注入，优先级高于 `AGENTS.md`，避免两套内容重复）。
- **Skill 默认加载**：用户级 `~/.claude/skills` 与项目级 `.claude/skills` 从「仅 claude 来源同步」提升为默认加载（与 syncSource 解耦）；`trae` 来源时 Trae Skill 照旧按既有逻辑加载，不破坏现有 Trae 生态。
- **系统提示词注入**：AGENTS.md 内容（用户级 + 项目级）以「项目级规范」身份注入系统提示词，标注来源路径。
- 新增/调整相关单元测试与 spec（`agents-md-loading` 新能力；`project-rules-injection`、`claude-config-sync` 需求变更）。

## Capabilities

### New Capabilities
- `agents-md-loading`: AGENTS.md 的默认加载机制（用户级 `~/.claude/AGENTS.md` + 项目级 `AGENTS.md`），与 syncSource 解耦，并将内容注入系统提示词。

### Modified Capabilities
- `project-rules-injection`: 项目规范加载规则变更——AGENTS.md 从 CLAUDE.md 回退项提升为默认加载文件，并支持用户级全局 AGENTS.md；CLAUDE.md 仍保留（claude 来源时优先）。
- `claude-config-sync`: Skill 同步规则变更——用户级与项目级 `.claude/skills` 从「仅 claude 来源时同步」变为默认加载，与 syncSource 解耦。

## Impact

- `src/agent/projectRules.ts`: 改造为「用户级 + 项目级」AGENTS.md/CLAUDE.md 统一加载器（或新增 `agentFiles.ts`），包含大小上限、失败降级、日志。
- `src/agent/agentLoop.ts`: `buildSystemPrompt` 调用处调整规则加载逻辑（不再完全依赖 `syncSource`）。
- `src/agent/systemPrompt.ts`: 项目规范段落支持多来源（用户级 + 项目级）标注。
- `src/extension.ts`: `syncSkills` 中 Claude Skill 目录改为默认加载，与来源切换解耦。
- `src/config/syncConfig.ts`: 若需要，调整来源语义或新增独立开关（如 `agents.md` 默认加载开关）。
- `src/test/**`: 新增/更新 `projectRules`、`syncSkills`、`systemPrompt` 相关测试。
- `openspec/specs/`: 更新 `project-rules-injection`、`claude-config-sync`，新增 `agents-md-loading`。

> **需确认的假设**：① AGENTS.md 与 Claude Skill 的默认加载与 syncSource 解耦（`none` 来源也加载）；② 新增用户级 `~/.claude/AGENTS.md`；③ CLAUDE.md 保留且优先级高于 AGENTS.md（向后兼容）；④ Trae 来源下 Claude Skill 与 Trae Skill 并存加载。若与预期不符请在评审时指出。
