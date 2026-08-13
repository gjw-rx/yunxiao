# Tasks: AGENTS.md 默认加载 + 全局/项目 Skill 加载

## 1. Agent 文件加载器改造（projectRules.ts）

- [x] 1.1 扩展 `ProjectRules` 类型：`source` 单字段改为 `sources: string[]`（来源路径列表，全局在前、项目在后），补充字段中文说明注释
- [x] 1.2 `loadProjectRules` 增加用户级加载：`~/.claude/AGENTS.md` 存在则读取，不存在回退 `~/.claude/CLAUDE.md`（两者均无则跳过全局部分）
- [x] 1.3 项目级加载保留既有顺序：`CLAUDE.md` 优先，回退 `AGENTS.md`；缺失时项目级部分为空
- [x] 1.4 每份文件独立校验 `PROJECT_RULES_MAX_BYTES` 上限：超限跳过该份并记录日志，不影响其他份
- [x] 1.5 拼接返回：全局在前、项目在后，`sources` 记录每份完整路径；全部缺失返回 `null`
- [x] 1.6 关键步骤补日志：每份文件读取成功/失败/超限、最终拼接来源列表

## 2. 系统提示词多来源标注（systemPrompt.ts）

- [x] 2.1 `buildProjectRulesSection` 改为按 `rules.sources` 数组标注来源（逗号分隔完整路径）
- [x] 2.2 校验：`source` 字段移除后所有引用点（含 agentLoop 调用处）同步更新，`npm run check-types` 通过

## 3. AgentLoop 规则加载解耦（agentLoop.ts）

- [x] 3.1 `buildSystemPrompt` 调用处：`projectRules` 改为始终调用 `loadProjectRules(workspaceRoot)`（不再依赖 `syncSource === 'claude'`）
- [x] 3.2 `traeRules` 保持仅 `syncSource === 'trae'` 时注入；`none` 来源注入 AGENTS.md（用户级 + 项目级）
- [x] 3.3 更新相关注释与日志（说明 AGENTS.md 默认加载、与 syncSource 解耦）

## 4. Claude Skill 默认加载（extension.ts）

- [x] 4.1 从 `syncSkills()` 中拆出 Claude Skill 目录（`~/.claude/skills` + 项目 `.claude/skills`）为常驻默认加载逻辑
- [x] 4.2 常驻加载不随 `syncSource` 变化，且切源/刷新时不被卸载（不进 `syncedSkillNames` 卸载循环）
- [x] 4.3 Trae Skill 目录保留既有来源绑定逻辑（仅 `trae` 加载，仍走 `syncedSkillNames` 卸载）
- [x] 4.4 保留去重规则（项目优先、同名不覆盖）并补日志

## 5. 测试

- [x] 5.1 更新 `src/test/agent/projectRules.test.ts`：用户级加载、全局回退 CLAUDE.md、全局+项目拼接顺序、超限跳过、读取失败降级
- [x] 5.2 新增/更新系统提示词多来源标注测试（`projectRules` 注入含多个来源路径）
- [x] 5.3 更新 `src/test/config/syncConfig.test.ts` 或相关测试：`none` 来源下 AGENTS.md 与 Claude Skill 仍加载
- [x] 5.4 新增切源场景测试：`none`→`trae` 时 Claude Skill 保留、Trae Skill 加载

## 6. 验证与收尾

- [x] 6.1 运行 `npm run compile`（check-types + lint）全部通过
- [x] 6.2 运行 `npm test` 全部通过
- [x] 6.3 更新 openspec/specs：归档 change 后同步 `agents-md-loading`（新）、`project-rules-injection`、`claude-config-sync` 三个 spec
