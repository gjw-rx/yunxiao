## Context

云效 Agent 插件（VSCode 扩展，TypeScript strict）已具备：Claude 配置同步（`src/extension.ts:159-200` 的 `syncClaudeSkills` + `src/config/claudeConfig.ts` 的 `getSyncEnabled`/`onClaudeConfigChange`）、Skill 加载/注册/工具化（`src/skill/`：`loadSkillsFromDirectory` 异步扫描目录下 `*.md`、`SkillRegistry.register/unregister/get/list/listSlashCommands`、`SkillTool`）、项目规范注入（`src/agent/projectRules.ts` 的 `loadProjectRules`：CLAUDE.md → AGENTS.md 回退；`src/agent/systemPrompt.ts` 的 `buildSystemPrompt` 拼接 `<project_rules>` 段；`src/agent/agentLoop.ts:146-156` 每轮调用）、斜杠命令推送（`chatPanel.refreshSlashCommands()`）。

关键现状（来自代码调研 + Trae 官方文档检索）：

- Trae 配置目录：`.trae/`（国际版）与 `.trae-cn/`（国内版）；`rules/` 下放 Markdown 规则（frontmatter 可选：`alwaysApply`/`description`/`globs`/`scene`；支持 ≤3 层子目录），`skills/<name>/SKILL.md` 为 Anthropic Agent Skills 标准格式（必需 `name`/`description` frontmatter），全局技能存 `~/.trae/skills`（macOS/Linux）。官方文档：https://docs.trae.ai/ide/rules 、https://docs.trae.ai/ide/skills 。
- `loadSkillsFromDirectory`（skillLoader.ts:88-132）仅遍历一级 `*.md`，**不识别** `<dir>/<name>/SKILL.md` 嵌套结构——Claude 同步与 Trae 同步对标准 SKILL 资产实际加载不到，需扩展。
- 项目根 `.trae/` 已有真实样例：`rules/project_rules.md`（纯 Markdown 无 frontmatter）、`skills/openspec-*/SKILL.md`（含 name/description frontmatter）。
- 既有 Claude 同步的用户级路径为 `os.homedir()/claude/skills`（缺前导点号，实为 `~/claude/skills`），**既有缺陷**，不在本期范围修复（Trae 实现使用正确路径 `~/.trae`、`~/.trae-cn`）。

约束：日志统一走 `src/logger.ts`；函数需 JSDoc 中文注释；文件读取复用安全策略（大小上限、失败静默降级）；改动遵循「最小代码、外科手术式」原则；与既有 Claude 同步对称，不重复实现。

## Goals / Non-Goals

**Goals:**

- 新增配置「同步TRAE配置」（`yunxiaoAgent.trae.syncEnabled`，默认 false）：开启后把 `~/.trae/skills`、`~/.trae-cn/skills` 与 `<workspaceRoot>/.trae/skills`、`<workspaceRoot>/.trae-cn/skills` 中的 SKILL 注册进 `skillRegistry`，供斜杠菜单与 skill 工具使用；关闭时卸载，配置变更热生效并刷新斜杠命令。
- `loadSkillsFromDirectory` 支持标准嵌套结构 `<dir>/<name>/SKILL.md`（一层），使 Claude 与 Trae 目录同步对真实 SKILL 资产生效，同时保留既有扁平 `*.md` 扫描（向后兼容）。
- 新增 `src/agent/traeRules.ts`：扫描 `<workspaceRoot>/.trae/rules` 与 `<workspaceRoot>/.trae-cn/rules`（递归 ≤3 层）收集规则文件，拼接后以「Trae 项目规则」注入系统提示词，始终生效（与 `CLAUDE.md` 注入对称）。

**Non-Goals:**

- 不读取 Trae 目录中除 SKILL 与 rules 之外的内容（`skill-config.json` 禁用清单、MCP 配置、内置设计技能等）。
- 不解析 rules frontmatter 的 `globs`/`scene`/`alwaysApply` 语义（Trae 的「按文件生效」「智能应用」模式）：本期将全部规则文件视为全量生效注入，frontmatter 原样保留在正文中供模型理解。
- 不引入超过一层的 SKILL 嵌套扫描（Anthropic Agent Skills 标准即 `<dir>/<name>/SKILL.md` 一层）。
- 不修复既有 Claude 用户级路径缺陷（`~/claude` 缺前导点号），仅在日志与文档中记录。
- 不新增第三方依赖。

## Decisions

### D1：配置 `yunxiaoAgent.trae.syncEnabled`（默认 false）

新增配置项（`package.json` `contributes.configuration`，`scope: "window"`，命名「同步TRAE配置」），默认 `false`：读取用户 home 目录属隐式外部输入，默认关闭更安全（与 Claude 同步 D3 一致）。`src/config/traeConfig.ts` 完全复用 `claudeConfig.ts` 模式：`getSyncEnabled()` 读 `yunxiaoAgent.trae.syncEnabled`；`onTraeConfigChange(cb)` 监听 `affectsConfiguration('yunxiaoAgent.trae')` 触发回调。

### D2：skillLoader 支持一层嵌套 SKILL.md

`loadSkillsFromDirectory(dirPath)` 扫描逻辑扩展为两段：

1. 既有：`dirPath/*.md`（扁平，向后兼容，如 `.vscode/skills/plan.md`）；
2. 新增：对 `dirPath` 下的每个子目录 `<name>`，若存在 `<name>/SKILL.md`，解析并加载（Skill 的 `name` 取 frontmatter 的 `name`；frontmatter 缺失或缺少 name/description 时跳过并记日志）。

深度固定一层，不递归。该结构是 Anthropic Agent Skills 与 Trae/Claude Code 的统一格式，扩展后 Claude 同步与 Trae 同步对真实资产均生效。

### D3：Trae SKILL 同步（trae-config-sync）

`src/extension.ts` 新增 `syncTraeSkills()`，与 `syncClaudeSkills` 对称：

- 记录本次注册的 skill 名（`traeSkillNames`），关闭或重同步时先按名 `unregister`（仅卸载来自 Trae 目录的 skill）。
- 目录顺序（先注册者优先，同名后者跳过）：用户级 `~/.trae/skills` → `~/.trae-cn/skills` → 项目级 `<root>/.trae/skills` → `<root>/.trae-cn/skills`。目录不存在时 `loadSkillsFromDirectory` 返回 `[]` 天然容错。
- 去重：显式配置目录（`yunxiaoAgent.skills.directories`）先加载 → Claude 同步 → Trae 同步；同名时 Trae 目录**不覆盖**已有注册（仅补缺），日志记录跳过项。
- 配置变更热生效：`onTraeConfigChange` 触发时重新执行 `syncTraeSkills()`，末尾调用 `provider.refreshSlashCommands()` 刷新斜杠命令。

### D4：Trae 规则注入（trae-rules-injection）

新增 `src/agent/traeRules.ts`：

```ts
interface TraeRules { sources: string[]; content: string }
async function loadTraeRules(workspaceRoot: string): Promise<TraeRules | null>
```

- 扫描 `<root>/.trae/rules` 与 `<root>/.trae-cn/rules`，递归收集 `*.md`（深度 ≤3，与 Trae 规范一致），目录不存在静默跳过。
- 拼接格式：每个文件以 `## 来源: <相对路径>` 为标题，后接文件内容；文件间空行分隔；frontmatter 原样保留。
- 安全策略复用 `projectRules.ts`：整体大小上限 64KB（超限跳过并记日志）、读取失败静默降级返回 `null`。
- **始终生效**（不受 `syncEnabled` 控制）：读取的是项目内文件，无隐私/外部性，与既有 `CLAUDE.md` 注入边界一致（claude change D4 边界说明）。
- `systemPrompt.ts`：`SystemPromptContext` 增加 `traeRules?: TraeRules | null`；`buildSystemPrompt` 在 `<project_rules>` 段之后插入 `<trae_rules>` 段（「Trae 项目规则」声明 + 来源列表 + 内容）。
- 调用点：`agentLoop.ts:146-156` 构建提示词处每轮调用 `loadTraeRules`（与 `loadProjectRules` 并列）。

### D5：去重与优先级

显式配置目录 > Claude 目录 > Trae 目录。实现上靠装配顺序保证：`skillDirs` 加载 → `syncClaudeSkills()` → `syncTraeSkills()`，后者对 `skillRegistry.get(name)` 已存在者跳过。Trae 内部先用户级后项目级（与 Claude 同步顺序一致）。

## Risks / Trade-offs

- [读 `~/.trae` 引入用户 home 目录内容] → 仅同步 SKILL 的 `*.md`（用户自建文本），大小限制 + 仅提取 name/description；默认关闭开关；变更时日志记录。
- [rules 全量注入导致提示词膨胀] → 整体 64KB 上限；项目内规则文件通常短小（本项目 `project_rules.md` 2KB）。
- [嵌套扫描可能重复加载] → 扁平 `*.md` 与 `<name>/SKILL.md` 两种形态天然不重叠（同名文件不同路径）；同名 skill 由注册表按名去重（仅补缺）。
- [每轮读文件的 IO 开销] → 与 `loadProjectRules` 相同，量级微秒-毫秒，可忽略；失败静默降级。

## Migration Plan

- 纯新增能力，无数据迁移、无既有行为变更。`syncEnabled` 默认关闭，不影响现有用户；skillLoader 嵌套扫描为向后兼容增强（原扁平结构行为不变）。
- 回滚：删除配置项与 `traeRules` 注入段即可；Trae 同步关闭时不加载任何 Trae 内容，自然降级。

## Open Questions

1. Trae rules frontmatter 的 `globs`（按文件生效）与 `scene`（场景触发）语义本期不解析，全部按全量注入。若后续需要「仅特定文件生效」，需另立 spec。
2. `syncEnabled` 默认值当前 `false`（隐私安全）；若产品预期「开箱即用」，可改为 `true`。
