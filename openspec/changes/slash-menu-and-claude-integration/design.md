## Context

云效 Agent 插件（VSCode 扩展，TypeScript strict）已有：聊天 Webview 面板（`src/chatPanel.ts`）、Skill 加载/注册/工具化（`src/skill/`：`loadSkillsFromDirectory` 异步扫描目录下 `*.md`、`SkillRegistry.register/list/listSlashCommands`、`SkillTool`）、配置读取模式（`src/config/modelConfig.ts`：`getConfiguration` + DEFAULTS + `onModelConfigChange` 的 `affectsConfiguration` 过滤）、系统提示词构建（`src/agent/systemPrompt.ts` 的 `buildSystemPrompt(context: SystemPromptContext)`，拼接 agentPrompt + `<env>` + `<available_skills>`）。

关键现状（来自代码调研）：

- `src/chatPanel.ts` 斜杠菜单的 UI 骨架已存在：`#slashCommandPicker` DOM、样式、键盘导航（↑↓/Enter/Esc）、`handleSlashTrigger()` 检测 `/`、`renderSlashCommands()`、`selectSlashCommand()`；但命令列表是硬编码空数组（:1613），选中后仅清空输入框（:2048-2053），扩展侧无推送命令数据，webview 无请求命令数据的消息。
- skill 加载目录仅来自配置 `yunxiaoAgent.skills.directories`（默认 `.vscode/skills`），在 `extension.ts:_activate` :139-152 装配；无 `~/.claude` 或 `.claude/skills` 逻辑。
- `buildSystemPrompt` 不拼接任何项目规范文件；`SystemPromptContext`（systemPrompt.ts:90-105）含 agentPrompt/skills/workspaceRoot/platform/date/modelId/providerId。
- 项目根已有 `AGENTS.md` 与 `CLAUDE.md`（内容一致）；项目 `.claude/skills/` 下有 openspec 系列 4 个 skill；`~/.claude/` 下无 skills 目录（仅 CLAUDE.md/settings 等），但**目录可能不存在**，代码必须容错。
- 项目内无读取 `~/.claude`、`CLAUDE.md`、`AGENTS.md` 的任何现成逻辑（grep 0 匹配），需从零实现。

约束：日志统一走 `src/logger.ts`；函数需 JSDoc 中文注释；文件读取复用安全策略（大小限制、二进制检测，参考 `chatPanel.ts:_readReferencedFile` :347-383）；改动遵循「最小代码、外科手术式」原则。

## Goals / Non-Goals

**Goals:**

- 输入框输入 `/` 弹出分组命令菜单（基础功能 / 子智能体 / SKILL与命令），支持键盘导航、选中回填或直接发送。
- 新增配置「同步CLAUDE配置」(`yunxiaoAgent.claude.syncEnabled`)：开启后把 `~/.claude/skills` 与 `<workspaceRoot>/.claude/skills` 中的 SKILL 注册进 `skillRegistry`，供斜杠菜单与 skill 工具使用。
- `buildSystemPrompt` 加载项目根 `CLAUDE.md`（不存在时回退 `AGENTS.md`）作为「项目级规范」注入系统提示词，并声明任何开发必须遵循。
- 全部复用现有斜杠菜单 UI 骨架、skill 基础设施、配置读取模式，改动最小。

**Non-Goals:**

- 不读取 Claude 目录中除 SKILL 之外的内容（`commands`、`settings.json`、MCP 配置、历史会话等）。
- 不实现真正的子智能体执行器：本期「子智能体」分类仅作为 skill 的一种类型标识，执行仍走现有 `SkillTool`。
- 不引入递归 skill 目录扫描（保持 `loadSkillsFromDirectory` 非递归现状）。
- 不修改任何既有 spec 的需求行为契约（斜杠菜单、skill 加载、提示词拼接均为新增/内部实现变化）。
- 不新增第三方依赖（仅用 Node 内置 `os` 读取 home 目录）。

## Decisions

### D1：斜杠菜单数据流 — 扩展侧推送 + webview 主动拉取

扩展侧新增 `postMessage({ command: 'slashCommands', payload: { groups: SlashCommandGroup[] } })`，在 webview `resolveWebviewView` 初始化时推送；同时 webview 保留「请求」消息 `requestSlashCommands`（仿照现有 `requestWorkspaceFiles` 模式），解决 webview 重建后数据丢失问题。

分组结构：

```ts
interface SlashCommandGroup {
  id: 'basic' | 'agents' | 'skills';
  label: string; // 基础功能 / 子智能体 / SKILL与命令
  commands: SlashCommand[];
}
interface SlashCommand {
  id: string;            // 唯一标识，如 'basic.newSession' / skill 名
  label: string;         // 展示名
  description?: string;  // 副标题
  kind: 'basic' | 'agent' | 'skill';   // 决定选中后的行为
  send?: boolean;        // true = 选中即发送，false = 回填输入框
}
```

- 基础功能：内置静态命令表（常量，如 新建会话、停止回复、插入项目文件），`send: false` 回填或直接触发对应消息。
- 子智能体：`skillRegistry.list()` 中 `type === 'agent'` 的 skill。
- SKILL与命令：其余 skill（含 `slash === true` 的斜杠 skill）。
- `selectSlashCommand(cmd)`：基础功能命令 `cmd.send` 为真 → 直接 `postMessage sendMessage`（或对应命令消息）；skill 命令（`skill.*`）选中后**不直接发送**，在对话框输入区生成 Skill 引用块（chip，带入场动画、可移除、去重），发送时随 `sendMessage` 以 `skills` 字段提交，扩展侧转成斜杠命令文本前置到用户消息；否则回填输入框并聚焦，由用户编辑后发送。

替代方案：webview 内嵌静态命令表。否决——子智能体/SKILL 数据来自扩展侧 skillRegistry，静态表无法覆盖，且配置变更后无法热更新。

### D2：SkillFrontmatter 增加可选 type 字段

`SkillFrontmatter`（src/skill/types.ts:6-13）现有 `name/description/slash`，新增可选 `type?: 'agent' | 'skill'`（默认 `'skill'`）。解析器 `parseFrontmatter`（skillLoader.ts:25-78）增加该字段读取。子智能体分类 = `type === 'agent'`。

替代方案：按目录区分（如 `~/.claude/agents/`）。否决——Claude Code 生态无此目录约定，且现有 `*.md` 单目录扫描模型不支持；frontmatter 标记最简单且向后兼容（缺省为 skill）。

### D3：同步配置 `yunxiaoAgent.claude.syncEnabled`（默认 false）

新增配置项（`package.json` `contributes.configuration`，`scope: "window"`，与现有 `yunxiaoAgent.skills.directories` 同块），命名「同步CLAUDE配置」。默认 `false`：读取用户 home 目录属于隐式外部输入，默认关闭更安全；description 明确说明功能。

- 开启时，`extension.ts` 装配处把 `os.homedir()/claude/skills` 与 `<workspaceRoot>/.claude/skills` 追加为 skill 加载目录（目录不存在时 `loadSkillsFromDirectory` 返回 `[]`，天然容错）。
- 优先级与去重：显式配置目录（`.vscode/skills` 等）先加载，Claude 目录后加载；同名 skill 时 Claude 目录**不覆盖**已有注册（用户显式配置优先），装配处按名去重。
- 配置变更热生效：复用 `onModelConfigChange`（modelConfig.ts:53-59）模式，`affectsConfiguration('yunxiaoAgent.claude')` 时重新加载并重新推送 `slashCommands`。

替代方案：读取 `~/.claude/settings.json` 中的 skills 配置。否决——settings.json 结构随 Claude Code 版本变动，且本期范围明确「仅 SKILL 与项目 CLAUDE.md」。

### D4：项目规范注入 — 每轮读取，CLAUDE.md 优先

新增 `src/agent/projectRules.ts`：

```ts
async function loadProjectRules(workspaceRoot: string): Promise<ProjectRules | null>
// ProjectRules = { source: 'CLAUDE.md' | 'AGENTS.md'; content: string }
```

- 查找顺序：`<root>/CLAUDE.md` → `<root>/AGENTS.md`；均不存在返回 `null`。两者都存在时仅读 `CLAUDE.md`（单一来源，避免重复/冲突，省 token）。
- `SystemPromptContext` 增加 `projectRules?: ProjectRules`；`buildSystemPrompt` 在 `<env>` 段之后插入 `<project_rules>` XML 块：开头强调「以下为项目级规范（来源：<path>），任何开发工作都必须遵循」，后接文件内容。
- 调用点：`agentLoop.ts` run 时（:146-154 构建 prompt 处）每轮调用 `loadProjectRules` 读取——文件可能被用户修改，每轮读一个文件成本可忽略，保证提示词最新。
- 读取安全：复用大小上限策略（超限截断并提示或跳过）、失败静默降级（读失败返回 `null`，不影响对话主流程，仅记日志）。

**边界**：功能三（项目规范注入）与 `syncEnabled` 解耦——项目规范注入**始终生效**（读取的是项目内文件，无隐私/外部性）；`syncEnabled` 只控制 Claude skills 目录同步。`claude-config-sync` 中「读取项目 CLAUDE.md」即功能三的输入，两者共享 `loadProjectRules`，不重复实现。

### D5：ChatViewProvider 装配方式

现有 `ChatViewProvider` 构造时 `sessionManager` 先传 null、:211 回填。skillRegistry 同理：构造时传入 `SkillRegistry`（或提供 `setSkillRegistry`），在 `resolveWebviewView` 时读取 `skillRegistry.list()` 组装分组推送。装配顺序（extension.ts）保证 skill 加载（:139-152）先于 provider 初始化消息发送。

## Risks / Trade-offs

- [读 `~/.claude/skills` 引入用户 home 目录内容] → 仅同步 SKILL 的 `*.md`（用户自建文本），大小限制 + 仅提取 name/description 用于菜单；默认关闭开关；变更时日志记录。
- [Claude 目录与显式目录 skill 同名覆盖] → 显式目录优先，Claude 目录仅补缺（D3 去重）。
- [CLAUDE.md 内容过大导致提示词膨胀] → 大小上限截断；仅读优先文件（不叠加 AGENTS.md）。
- [webview 重建后命令数据丢失] → webview 初始化时主动 `requestSlashCommands` 拉取（D1）。
- [每轮读文件的 IO 开销] → 单文件 stat+read，量级微秒-毫秒，可忽略；失败静默降级。

## Migration Plan

- 纯新增能力，无数据迁移、无既有行为变更。`syncEnabled` 默认关闭，不影响现有用户。
- 回滚：删除配置项与 `projectRules` 注入段即可；UI 骨架在功能未启用时不展示命令（空列表），自然降级。

## Open Questions

1. 子智能体分类：采用 skill frontmatter 增加 `type: agent` 标记（D2 默认方案）。若后续要支持独立子智能体执行器，需另立 spec。
2. `syncEnabled` 默认值：当前默认 `false`（隐私安全）。若产品预期「开箱即用」，可改为 `true`。
3. 「基础功能」分组的内容集合：当前先内置少量静态命令（新建会话、停止回复、@ 引用文件）；是否要暴露 `vscode.commands` 全量命令列表，需产品确认（本期不做，避免噪音）。
