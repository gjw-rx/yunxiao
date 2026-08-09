## Why

云效 Agent 插件已支持斜杠命令菜单与 Claude 配置同步（`yunxiaoAgent.claude.syncEnabled`：同步 `~/.claude/skills`、项目 `.claude/skills` 的 SKILL，并注入项目 `CLAUDE.md`）。但用户在其他 AI 编程工具中沉淀的资产仍无法复用：

1. Trae（字节跳动 AI IDE，含国际版 `.trae` 与国内版 `.trae-cn` 两个配置目录）中的 **SKILL**（`.trae/skills/<name>/SKILL.md`、`~/.trae/skills`）无法被本插件加载；
2. Trae 中的 **rules**（`.trae/rules/*.md`，支持子目录与可选 frontmatter）是 Trae 专属项目规范，不会进入系统提示词；
3. 现有 `loadSkillsFromDirectory` 仅扫描目录下扁平 `*.md`，**不支持** Anthropic Agent Skills 标准嵌套结构 `<dir>/<name>/SKILL.md`（Trae 与 Claude Code 的 SKILL 实际均为该结构），导致目录同步对真实 SKILL 资产无效。

现状（代码调研）：`src/extension.ts:159-200` 已有 Claude SKILL 同步（`syncClaudeSkills` + `onClaudeConfigChange` 热生效）；`src/agent/projectRules.ts` 仅解析 `CLAUDE.md` / `AGENTS.md`；`src/skill/skillLoader.ts:88-132` 的 `loadSkillsFromDirectory` 仅遍历一级 `*.md`；本项目根 `.trae/` 下已有 `rules/project_rules.md` 与 `skills/<name>/SKILL.md` 实际样例可验证。

## What Changes

1. **新增配置「同步TRAE配置」**（`yunxiaoAgent.trae.syncEnabled`，默认 false）：开启后读取 Trae 目录中的 SKILL——用户级 `~/.trae/skills`、`~/.trae-cn/skills` 与项目级 `.trae/skills`、`.trae-cn/skills`——注册进 `skillRegistry`，供斜杠菜单与 skill 工具使用；关闭时卸载本次注册的 Trae skill，配置变更热生效。**本期范围**：仅同步 SKILL，不读取 `skill-config.json`、MCP 配置等其他 Trae 目录内容。
2. **skillLoader 支持标准嵌套 SKILL 目录**：`loadSkillsFromDirectory` 在保留扁平 `*.md` 扫描的同时，识别 `<dir>/<name>/SKILL.md` 结构（一层嵌套，Anthropic Agent Skills / Trae 通用格式），使 Claude 与 Trae 目录同步对真实 SKILL 资产生效。
3. **Trae 规则注入系统提示词**：新增 `src/agent/traeRules.ts`，扫描项目 `.trae/rules` 与 `.trae-cn/rules`（递归 ≤3 层）收集全部 `*.md` 规则文件，拼接后以「Trae 项目规则」身份注入系统提示词；与 `CLAUDE.md` 注入一致**始终生效**（读取的是项目内文件，无隐私/外部性）。

## Capabilities

### New Capabilities

- `trae-config-sync`: 新增「同步TRAE配置」开关；开启后加载 `~/.trae/skills`、`~/.trae-cn/skills` 与项目 `.trae/skills`、`.trae-cn/skills` 的 SKILL 进注册表。
- `trae-rules-injection`: 扫描项目 `.trae/rules`、`.trae-cn/rules` 的规则文件（递归 ≤3 层）作为「Trae 项目规则」注入系统提示词。

### Modified Capabilities

- `skill-loading`（skillLoader）: 扫描逻辑从「仅一级 `*.md`」扩展为「一级 `*.md` + 一层 `<name>/SKILL.md` 子目录」，兼容既有扁平结构，行为向后兼容。

## Impact

- `package.json`：`contributes.configuration` 新增 `yunxiaoAgent.trae.syncEnabled`。
- `src/config/`：新增 `traeConfig.ts`（复用 `claudeConfig.ts` 的 getConfiguration + onDidChangeConfiguration 模式）。
- `src/skill/skillLoader.ts`：`loadSkillsFromDirectory` 增加一层子目录 SKILL.md 扫描。
- `src/extension.ts`：装配处新增 `syncTraeSkills()`（对称 `syncClaudeSkills`），配置变更热生效。
- `src/agent/`：新增 `traeRules.ts`；`systemPrompt.ts` 的 `SystemPromptContext` 扩展并拼接 Trae 规则段；`agentLoop.ts` 每轮调用。
- 新增依赖：无（复用 Node 内置 `os` / `fs`）。
