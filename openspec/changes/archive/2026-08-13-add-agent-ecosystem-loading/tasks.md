## 1. 来源契约与生态 Skill 同步

- [x] 1.1 将 `SyncSource`、校验列表、日志与相关 Webview 类型扩展为 `agent`，保持默认 Claude 和私有存储兼容。
- [x] 1.2 在扩展的生态目录决策中为 `agent` 加入 `os.homedir()/.agents/skills`，复用串行同步、显式目录优先及同名补缺逻辑。
- [x] 1.3 更新 Skill 设置页的来源选项、文案和同步结果展示，使 `agent` 可选且能显示来源路径。

## 2. Agent 项目规则与系统提示词

- [x] 2.1 在项目规则加载层实现仅读取工作区根 `AGENTS.md` 的 Agent 规则入口，复用大小限制、失败降级与关键步骤日志。
- [x] 2.2 扩展系统提示词上下文与构建函数，输出带来源标注的 `<agent_project_rules>` 段，并保留 Claude 与 Trae 的现有段落语义。
- [x] 2.3 在 AgentLoop 中按 `agent` 来源传入 Agent 规则，确保每次运行重新读取且任一时刻只注入一个生态规则段。

## 3. 测试与验证

- [x] 3.1 为来源枚举、切换同步和 Agent 全局目录优先级补充单元测试，覆盖目录缺失、同名去重和离开 Agent 来源。
- [x] 3.2 为 Agent `AGENTS.md` 读取和系统提示词注入补充单元测试，覆盖 Claude 共存、文件缺失、过大/读取失败及更新后重建。
- [x] 3.3 更新设置页和 Webview 协议测试，验证 `agent` 选项、成功切换后的快照与空状态。
- [x] 3.4 运行 `npm run compile` 和受影响测试；确认日志、类型检查、lint 与 OpenSpec 校验通过。
