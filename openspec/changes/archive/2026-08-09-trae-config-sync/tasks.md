## 1. 配置与 Skill 基础设施

- [x] 1.1 `package.json` `contributes.configuration` 新增配置 `yunxiaoAgent.trae.syncEnabled`（布尔、默认 false、scope window、显示名「同步TRAE配置」），并添加中文 description
- [x] 1.2 新增 `src/config/traeConfig.ts`：读取 `yunxiaoAgent.trae.syncEnabled`（复用 `claudeConfig.ts` 模式），提供 `getSyncEnabled()` 与 `onTraeConfigChange(cb)`，函数带 JSDoc、关键步骤打日志
- [x] 1.3 `src/skill/skillLoader.ts` 的 `loadSkillsFromDirectory` 支持一层嵌套 `<dir>/<name>/SKILL.md` 结构（保留既有扁平 `*.md` 扫描，向后兼容；frontmatter 缺失或缺少 name/description 时跳过并记日志）

## 2. Trae SKILL 同步（trae-config-sync）

- [x] 2.1 `src/extension.ts` 新增 `syncTraeSkills()`：开启时加载 `~/.trae/skills`、`~/.trae-cn/skills` 与 `<workspaceRoot>/.trae/skills`、`<workspaceRoot>/.trae-cn/skills`；目录不存在时静默跳过（loadSkillsFromDirectory 返回 []）
- [x] 2.2 同名 skill 去重：显式配置目录先加载、Claude 目录次之、Trae 目录最后且同名时不覆盖已有注册（仅补缺），日志记录跳过项；关闭时仅卸载来自 Trae 目录的 skill
- [x] 2.3 配置变更热生效：`onTraeConfigChange` 触发时重新执行 `syncTraeSkills()` 并刷新斜杠命令数据（`provider.refreshSlashCommands()`）

## 3. Trae 规则注入（trae-rules-injection）

- [x] 3.1 新增 `src/agent/traeRules.ts`：`loadTraeRules(workspaceRoot)` 扫描 `.trae/rules` 与 `.trae-cn/rules`（递归 ≤3 层）收集 `*.md`，返回 `{sources, content}`；复用文件安全策略（合计 64KB 上限、失败静默降级返回 null 并记日志）
- [x] 3.2 `src/agent/systemPrompt.ts`：`SystemPromptContext` 增加 `traeRules?` 字段；`buildSystemPrompt` 在 `<project_rules>` 段后插入 `<trae_rules>` 段（声明「Trae 项目规则」+ 来源列表 + 内容）
- [x] 3.3 `src/agent/agentLoop.ts` 构建提示词处（:146-156）每轮调用 `loadTraeRules` 并传入 `SystemPromptContext`；读取失败不影响主流程

## 4. 验证

- [x] 4.1 `npm run compile` 通过（check-types + lint + esbuild 打包）
- [x] 4.2 补充/运行相关单测（skillLoader 嵌套 SKILL.md 加载、traeRules 递归扫描与拼接），`npm test` 通过
- [ ] 4.3 手动验证（F5 扩展宿主）：开启「同步TRAE配置」后项目 `.trae/skills` 的 SKILL 进入斜杠菜单与 skill 工具；含 `.trae/rules` 项目会话的系统提示词包含 `<trae_rules>` 段
