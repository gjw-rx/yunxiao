## 1. Skill 类型定义

- [ ] 1.1 创建 `src/skill/types.ts`，定义 `Skill` 接口（name/description/content/slash?/sourcePath?）
- [ ] 1.2 定义 `SkillFrontmatter` 类型（name/description/slash?）
- [ ] 1.3 定义 `SkillSource` 类型（directory/embedded，仅声明不过度设计）

## 2. Skill 加载器

- [ ] 2.1 创建 `src/skill/skillLoader.ts`，实现 `parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter | null; body: string }` 纯函数
- [ ] 2.2 实现 `loadSkillsFromDirectory(dirPath: string): Promise<Skill[]>`：扫描 `*.md`，解析 frontmatter + body，跳过无效文件
- [ ] 2.3 处理目录不存在的场景：返回空数组，不抛异常

## 3. Skill 注册表

- [ ] 3.1 创建 `src/skill/skillRegistry.ts`，实现 `SkillRegistry` 类
- [ ] 3.2 实现 `register(skill)`、`unregister(name)`、`get(name)`、`list()`、`listSlashCommands()` 方法
- [ ] 3.3 重复注册时覆盖旧值

## 4. Skill 工具

- [ ] 4.1 创建 `src/skill/skillTool.ts`，继承 `BaseTool`，schema name="skill"，permission="read"，site="local"
- [ ] 4.2 实现 `execute(args, context)`：从 SkillRegistry 获取 Skill 内容，返回 success/error 结果
- [ ] 4.3 实现 `validate(args)`：校验 name 参数为非空字符串

## 5. 系统提示词构建器

- [ ] 5.1 创建 `src/agent/systemPrompt.ts`，定义 `DEFAULT_AGENT_PROMPT` 常量
- [ ] 5.2 定义 `SystemPromptContext` 接口（agentPrompt?/skills/workspaceRoot/platform/date）
- [ ] 5.3 实现 `buildEnvironmentSection(context)`：输出工作区/平台/日期
- [ ] 5.4 实现 `buildSkillGuidance(skills)`：输出使用说明 + XML 格式的 Skill 列表（skills 为空时返回空字符串）
- [ ] 5.5 实现 `buildSystemPrompt(context)`：拼接 agentPrompt + environment + skillGuidance

## 6. AgentLoop 集成

- [ ] 6.1 在 `AgentLoopConfig` 中新增 `agentPrompt?: string` 和 `skillRegistry?: SkillRegistry | null` 字段
- [ ] 6.2 在 AgentLoop.run() 中将 `TEMP_SYSTEM_PROMPT` 替换为 `buildSystemPrompt` 调用
- [ ] 6.3 删除 `TEMP_SYSTEM_PROMPT` 常量

## 7. 配置与插件入口

- [ ] 7.1 在 `package.json` 中新增 `yunxiaoAgent.skills.directories` 配置项（array，默认 [".vscode/skills"]）
- [ ] 7.2 在 `src/extension.ts` 中初始化 SkillRegistry：读取配置的目录，扫描并注册 Skills
- [ ] 7.3 在 `src/extension.ts` 中创建 skill 工具实例并注册到 ToolRegistry

## 8. 编译验证

- [ ] 8.1 运行 `npm run check-types` 确保无类型错误
- [ ] 8.2 运行 `npm run lint` 确保无 lint 错误
