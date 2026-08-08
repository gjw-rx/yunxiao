## Why

Phase 1-3 已完成本地 Agent Loop 的核心能力（模型连接层、记忆管理、工具循环），但 Agent Loop 目前使用硬编码的占位系统提示词，且无 Skill 加载能力。Phase 4 需要补齐这两块：构建可组合的系统提示词（含环境信息 + Skill guidance），并实现 Markdown 格式的 Skill 动态加载系统，使 LLM 能通过 `skill` 工具按需加载领域指令。

## What Changes

- 新建 `src/agent/systemPrompt.ts`：实现 `buildSystemPrompt(context)` 函数式拼接，包含默认 Agent 提示词、环境信息段、Skill guidance 段
- 新建 `src/skill/types.ts`：定义 `Skill`、`SkillSource`、`SkillFrontmatter` 类型
- 新建 `src/skill/skillLoader.ts`：从目录扫描 `*.md` 文件，解析 YAML frontmatter + 正文，无外部依赖
- 新建 `src/skill/skillRegistry.ts`：实现 `SkillRegistry` 类，支持注册/注销/查询/列命令
- 新建 `src/skill/skillTool.ts`：继承 `BaseTool`，实现 `skill` 工具，LLM 可通过工具调用加载 Skill 内容
- 修改 `src/agent/agentLoop.ts`：将硬编码系统提示词替换为 `buildSystemPrompt` 调用
- 在 `package.json` 新增 `yunxiaoAgent.skills.directories` 配置项
- 在插件激活时扫描 Skill 目录并注册

## Capabilities

### New Capabilities
- `system-prompt`: 可组合的系统提示词构建，包含 Agent 默认提示词、环境信息（工作区/平台/日期）、Skill guidance 注入
- `skill-system`: Skill 动态加载系统，支持从目录扫描 Markdown + frontmatter 格式的 Skill，注册到注册表，通过 skill 工具供 LLM 按需加载

### Modified Capabilities

## Impact

- 新增文件：`src/agent/systemPrompt.ts`、`src/skill/types.ts`、`src/skill/skillLoader.ts`、`src/skill/skillRegistry.ts`、`src/skill/skillTool.ts`
- 修改文件：`src/agent/agentLoop.ts`（替换系统提示词构建逻辑）、`src/extension.ts`（初始化 SkillRegistry 并注册 skill 工具）、`package.json`（新增 skills 配置项）
- 依赖：无新增外部依赖，YAML frontmatter 解析使用简单的字符串分割实现
- 现有工具链：skill 工具需注册到 ToolRegistry，复用已有的 BaseTool 抽象和安全机制
