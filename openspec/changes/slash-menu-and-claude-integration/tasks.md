## 1. 配置与 Skill 基础设施

- [X] 1.1 `package.json` `contributes.configuration` 新增配置 `yunxiaoAgent.claude.syncEnabled`（布尔、默认 false、scope window、显示名「同步CLAUDE配置」），并添加中文 description
- [X] 1.2 `src/skill/types.ts` 的 `SkillFrontmatter` 增加可选字段 `type?: 'agent' | 'skill'`（默认 'skill'），补中文注释
- [X] 1.3 `src/skill/skillLoader.ts` 的 `parseFrontmatter` 解析 `type` 字段并落入 `Skill`（缺失时默认 'skill'）
- [X] 1.4 新增 `src/config/claudeConfig.ts`：读取 `yunxiaoAgent.claude.syncEnabled`（复用 `modelConfig.ts` 的 getConfiguration + DEFAULTS + onConfigChange 模式），提供 `getSyncEnabled()` 与 `onClaudeConfigChange(cb)`，函数带 JSDoc、关键步骤打日志

## 2. Claude SKILL 同步（claude-config-sync）

- [X] 2.1 `src/extension.ts` 装配处（现 :139-152）：当 `getSyncEnabled()` 为 true 时，将 `os.homedir()/claude/skills` 与 `<workspaceRoot>/.claude/skills` 追加为 skill 加载目录；目录不存在时静默跳过（loadSkillsFromDirectory 已返回 []）
- [X] 2.2 同名 skill 去重：显式配置目录先加载，Claude 目录后加载且同名时不覆盖已有注册（仅补缺），日志记录跳过项
- [X] 2.3 配置变更热生效：`onClaudeConfigChange` 触发时重新执行 skill 目录加载（开启时加载 Claude 目录、关闭时移除来自 Claude 目录的 skill），并触发斜杠命令数据刷新（见 4.x）

## 3. 项目规范注入（project-rules-injection）

- [X] 3.1 新增 `src/agent/projectRules.ts`：`loadProjectRules(workspaceRoot)` 按 CLAUDE.md → AGENTS.md 顺序解析（两者都有时仅 CLAUDE.md，均无返回 null），返回 `{source, content}`；复用文件安全策略（大小上限、失败静默降级返回 null 并记日志）
- [X] 3.2 `src/agent/systemPrompt.ts`：`SystemPromptContext` 增加 `projectRules?` 字段；`buildSystemPrompt` 在 `<env>` 段后插入 `<project_rules>` 块（声明「项目级规范，任何开发必须遵循」+ 来源路径 + 内容）
- [X] 3.3 `src/agent/agentLoop.ts` 构建提示词处（:146-154）每轮调用 `loadProjectRules` 并传入 `SystemPromptContext`；读取失败不影响主流程

## 4. 斜杠命令菜单（slash-command-menu）

- [X] 4.1 新增 `src/chat/slashCommands.ts`（或并入 chatPanel）：定义 `SlashCommandGroup`/`SlashCommand` 类型与基础功能静态命令表（新建会话、停止回复、@ 引用文件等，send:false 回填类 + send:true 直达类）
- [X] 4.2 组装函数 `buildSlashCommandGroups(skillRegistry)`：基础功能 = 静态表；子智能体 = skill 中 `type==='agent'`；SKILL与命令 = 其余 skill（含 slash 命令）
- [X] 4.3 `src/chatPanel.ts` 扩展侧：处理 webview `requestSlashCommands` 消息并 `postMessage({command:'slashCommands', payload:{groups}})`；在 resolveWebviewView 初始化序列中推送；skill 注册变化/配置变更后重新推送
- [X] 4.4 `src/chatPanel.ts` webview 侧：将 `slashCommands` 硬编码空数组（:1613）改为接收扩展推送的数据；初始化时发送 `requestSlashCommands`
- [X] 4.5 `selectSlashCommand`（:2048-2053）实现行为：`send:true` 直接发送（postMessage sendMessage 或对应命令消息），`send:false` 回填输入框并聚焦；选中后关闭菜单
- [X] 4.6 校验/补齐 `handleSlashTrigger`/`renderSlashCommands` 的分组渲染与过滤逻辑（保留现有键盘导航骨架）

## 5. 验证

- [X] 5.1 `npm run compile` 通过（check-types + lint + esbuild 打包）
- [X] 5.2 补充/运行相关单测（skillLoader type 解析、projectRules 文件解析回退顺序、buildSlashCommandGroups 分组），`npm test` 通过
- [X] 5.3 手动验证（F5 扩展宿主）：输入 `/` 弹出三分类菜单、键盘导航与回填/发送行为；开启/关闭「同步CLAUDE配置」后菜单与 skill 工具联动；含 CLAUDE.md 项目会话的系统提示词包含 `<project_rules>` 段
