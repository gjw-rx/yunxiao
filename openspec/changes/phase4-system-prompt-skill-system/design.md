## Context

Phase 1-3 已完成本地 Agent Loop 核心：LLM 连接层（`src/llm/`）、记忆管理（`src/memory/`）、Agent 循环（`src/agent/agentLoop.ts`）均已就绪。

当前 AgentLoop 使用硬编码的 `TEMP_SYSTEM_PROMPT` 占位（见 [agentLoop.ts](file:///Users/jiaweigu/Python_project/VSCode插件开发/VSCode-plugin/src/agent/agentLoop.ts#L46-L53)），缺少：
1. 环境信息注入（工作区根、平台、日期）
2. Skill guidance（可用 Skill 列表注入系统提示词）
3. Skill 动态加载机制（LLM 通过工具按需加载领域指令）

工具体系已有完善的 BaseTool 抽象、ToolRegistry 注册、ToolRouter 路由（含安全审计+审批），可复用。Skill 目录 `src/skill/` 已创建但为空。

## Goals / Non-Goals

**Goals:**
- 实现 `buildSystemPrompt(context)` 函数式拼接，输出包含 Agent 提示词 + 环境信息 + Skill guidance
- 实现 Skill 类型定义、加载器（目录扫描 + frontmatter 解析）、注册表
- 实现 `skill` 工具（继承 BaseTool），LLM 可通过工具调用加载 Skill 内容
- 将 AgentLoop 中的 TEMP_SYSTEM_PROMPT 替换为 buildSystemPrompt 调用
- 新增 `yunxiaoAgent.skills.directories` 配置项

**Non-Goals:**
- 不实现 Skill 的 URL 加载（仅支持本地目录）
- 不实现 embedded 内联 Skill（仅目录扫描）
- 不引入 YAML 解析库（用简单字符串分割实现 frontmatter 解析）
- 不实现 `/` 斜杠命令触发 Skill（listSlashCommands 仅做查询，不接前端）
- 不修改前端 ChatPanel（Phase 6 处理）

## Decisions

### D1: 系统提示词函数式拼接（非类）

**选择**：`buildSystemPrompt(context: SystemPromptContext): string` 纯函数。

**理由**：系统提示词是无状态拼接逻辑，无需维护实例状态。opencode 用 SystemContext 代数（可组合 source），但本项目简化为单函数即可满足需求。

**替代方案**：SystemContext 类（可组合 .baseline().environment().skills() 链式调用）——过度设计，当前只有三段拼接。

### D2: Skill frontmatter 用简单字符串分割解析

**选择**：检测文件首行 `---`，按 `---` 分隔提取 YAML frontmatter，再按 `key: value` 行解析。

**理由**：frontmatter 只需 name/description/slash 三个字段，无需完整 YAML 解析器。保持零依赖。

**替代方案**：引入 `gray-matter` 或 `js-yaml`——增加依赖且功能远超需求。

### D3: skill 工具权限为 read（免审批）

**选择**：skill 工具 schema.permissions = 'read'，site = 'local'。

**理由**：skill 工具仅返回 Markdown 文本内容（从 SkillRegistry 读取），不修改文件系统、不执行命令，与 fs.read_file 同属只读安全级别。复用现有审批网关的 read 自动放行逻辑。

### D4: SkillRegistry 独立于 ToolRegistry

**选择**：SkillRegistry 是独立类，不混入 ToolRegistry。skill 工具持有 SkillRegistry 引用。

**理由**：ToolRegistry 管理的是 BaseTool 实例（name+schema+execute），Skill 管理的是 Markdown 内容（name+description+content）。两者职责不同，混入会增加 ToolRegistry 的复杂度。skill 工具作为桥梁：它在 ToolRegistry 注册为 BaseTool，execute 时从 SkillRegistry 获取内容。

### D5: AgentLoop 持有 SkillRegistry 引用

**选择**：AgentLoop 构造函数新增 `skillRegistry` 参数，用于构建系统提示词时传入可用 Skill 列表。

**理由**：系统提示词每轮循环都重建（因为可能动态加载新 Skill），需要实时从 SkillRegistry 获取列表。

## Risks / Trade-offs

- **[frontmatter 解析不健壮]** -> 只支持标准 `---` 分隔的简单 YAML，不支持多行值、嵌套对象。足够覆盖 name/description/slash 三个字段。解析失败时跳过文件并记录警告，不中断加载。
- **[Skill 目录不存在]** -> 加载器静默返回空数组，不报错。用户可能忘记创建目录——通过日志提示。
- **[系统提示词每轮重建]** -> 增加少量 CPU 开销。但系统提示词通常 < 2KB 字符串拼接，开销可忽略。
