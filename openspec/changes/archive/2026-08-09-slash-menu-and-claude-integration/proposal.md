## Why

云效 Agent 插件已具备对话面板、本地工具、Skill 注册等基础设施，但缺少三类「类 Claude Code」体验，导致用户既有资产无法复用、Agent 行为易偏离项目约定：

1. 聊天输入框输入 `/` 没有斜杠命令菜单，内置功能、子智能体、SKILL 无法被快速发现与调用；
2. 用户在 Claude Code 中沉淀的 SKILL（`~/.claude/skills`、项目 `.claude/skills`）与项目 `CLAUDE.md` 无法被本插件复用，需要重复维护；
3. 项目级规范（`CLAUDE.md` / `AGENTS.md`）不会进入系统提示词，Agent 开发时可能违背项目约定。

现状：`src/chatPanel.ts` 中斜杠菜单的 UI 骨架（DOM、样式、键盘导航、`/` 触发检测、渲染、选中）已存在，但命令列表是硬编码空数组、选中后无任何行为（chatPanel.ts:1613、2048-2053）；skill 加载目录仅支持配置项 `yunxiaoAgent.skills.directories`（默认 `.vscode/skills`），无 `~/.claude` 相关逻辑；`buildSystemPrompt` 不拼接任何项目规范文件。

## What Changes

1. **斜杠命令菜单**：聊天输入框输入 `/` 弹出分组候选，分组为「基础功能」「子智能体」「SKILL与命令」，支持键盘 ↑↓ 导航、Enter 选中、Esc 关闭；选中后回填输入框或直接发送。命令数据由扩展侧推送（基础功能来自内置命令表，子智能体与 SKILL 来自 `skillRegistry`）。
2. **新增配置「同步CLAUDE配置」**（`yunxiaoAgent.claude.syncEnabled`）：开启后读取 Claude 目录中的 SKILL 部分——用户级 `~/.claude/skills` 与项目级 `.claude/skills`——注册进 `skillRegistry`；同时读取项目根 `CLAUDE.md`。**本期范围**：仅读取 SKILL 与项目 `CLAUDE.md`，不读取 `commands`、`settings.json`、MCP 配置等其他 Claude 目录内容。
3. **项目级规范注入系统提示词**：`buildSystemPrompt` 加载项目根 `CLAUDE.md`（不存在时回退 `AGENTS.md`），以「项目级规范」身份拼接进系统提示词，并明确声明任何开发都必须遵循。

## Capabilities

### New Capabilities

- `slash-command-menu`: 聊天输入框 `/` 触发分组命令菜单（基础功能 / 子智能体 / SKILL与命令），命令数据由扩展侧推送，支持键盘导航与选中回填/发送。
- `claude-config-sync`: 新增「同步CLAUDE配置」开关；开启后加载 `~/.claude/skills` 与项目 `.claude/skills` 的 SKILL 进注册表，并读取项目 `CLAUDE.md`。
- `project-rules-injection`: 将项目根 `CLAUDE.md`（回退 `AGENTS.md`）作为项目级规范注入系统提示词，声明开发必须遵循。

### Modified Capabilities

（无。现有 spec 无需求级行为变化：斜杠菜单为全新能力，skill 加载与系统提示词改造不改变既有 spec 的对外行为契约。）

## Impact

- `src/chatPanel.ts`：`slashCommands` 数据来源改为扩展侧推送；`selectSlashCommand` 增加回填/发送行为；webview 消息协议新增命令推送消息。
- `src/skill/`：`skillLoader` 支持多目录来源与重复 skill 去重；`skillRegistry` 暴露分组查询（基础功能/子智能体/SKILL）。
- `src/config/`：新增 claude 配置读取（复用 `modelConfig.ts` 的 `getConfiguration` + DEFAULTS + `onConfigChange` 模式）。
- `src/agent/systemPrompt.ts`、`agentLoop.ts`：`SystemPromptContext` 扩展，读取并拼接项目规范文件。
- `src/extension.ts`：装配处扩展 skill 加载目录（追加 Claude skills 目录）、推送斜杠命令数据、传入项目规范。
- `package.json`：`contributes.configuration` 新增 `yunxiaoAgent.claude.syncEnabled`（及可能的配套项）。
- 新增依赖：`os`（Node 内置，读取 home 目录）；无第三方依赖新增。
