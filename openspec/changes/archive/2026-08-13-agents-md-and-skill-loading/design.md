# 设计文档：AGENTS.md 默认加载 + 全局/项目 Skill 加载

## Context

- 现状 `src/agent/projectRules.ts` 从项目根按 `CLAUDE.md → AGENTS.md` 顺序读取单份规范文件，返回 `{ source, content }`；不读取用户级全局文件。
- 现状 `src/extension.ts` 的 `syncSkills()` 将 Claude/Trae Skill 目录加载全部绑定在 `syncSource`（`none | claude | trae`）上：仅 `claude` 来源加载 `~/.claude/skills` + 项目 `.claude/skills`；来源切换时通过 `syncedSkillNames` 卸载再加载。
- 现状 `src/agent/agentLoop.ts` 每轮构建系统提示词时按 `syncSource` 二选一注入：`claude` → `loadProjectRules`，`trae` → `loadTraeRules`，`none` → 均不注入。
- `src/agent/systemPrompt.ts` 的 `buildProjectRulesSection` 仅接受单一来源的 `ProjectRules`，prompt 中标注单个来源文件名。

目标行为（参考 Claude Code）：`AGENTS.md` 作为通用 Agent 指令文件**默认加载**（用户级 + 项目级），Claude 生态 Skill（全局 + 项目）**默认可用**，均不依赖用户手动选择配置来源。

## Goals / Non-Goals

**Goals:**
- 项目级 `AGENTS.md` 默认加载（`syncSource` 为 `none` 时也加载）。
- 新增用户级 `~/.claude/AGENTS.md` 默认加载。
- `CLAUDE.md` 向后兼容：`syncSource === 'claude'` 时仍注入且优先级高于项目级 `AGENTS.md`。
- 用户级 `~/.claude/skills` 与项目级 `.claude/skills` 默认加载，与 `syncSource` 解耦。
- Trae 生态不受破坏：`syncSource === 'trae'` 时 Trae Skill / Trae 规则照旧按既有逻辑加载。
- 系统提示词中标注 AGENTS.md 各来源文件路径。

**Non-Goals:**
- 不实现 Claude Code 的「从当前目录向上递归查找 AGENTS.md」层级记忆（本期仅项目根 + 用户级）。
- 不读取 `~/.claude/commands`、`settings.json`、MCP 配置等其他生态内容。
- 不新增 AGENTS.md 的 UI 编辑/管理界面。
- 不改变 Trae 规则（`.trae/rules`）的既有加载机制。

## Decisions

### 决策 1：扩展 `projectRules.ts` 为多来源 Agent 文件加载器（不新建文件）

沿用现有模块，减少文件数与装配改动。`ProjectRules` 类型扩展：

```ts
interface ProjectRules {
  /** 来源文件路径列表（按注入顺序，全局在前、项目在后） */
  readonly sources: string[];
  /** 拼接后的规范内容 */
  readonly content: string;
}
```

`loadProjectRules(workspaceRoot)` 语义变为「加载默认 Agent 文件」：
1. 用户级：`~/.claude/AGENTS.md`（存在则读，保留 `~/.claude/CLAUDE.md` 作为回退）；
2. 项目级：`CLAUDE.md` 优先（既有行为，向后兼容），否则 `AGENTS.md`；
3. 每份文件独立校验 `PROJECT_RULES_MAX_BYTES` 上限，超限跳过该份并记日志；
4. 所有读取失败静默降级；全部缺失返回 `null`。

**备选**：新建 `agentFiles.ts`。否决——与 `projectRules.ts` 职责高度重合，拆分增加装配成本且无收益。

### 决策 2：AGENTS.md 与 syncSource 解耦，CLAUDE.md 保持来源绑定

`agentLoop.ts` 中规则加载改为：

```ts
const projectRules = await loadProjectRules(workspaceRoot); // 始终尝试（AGENTS.md 默认加载）
const traeRules = syncSource === 'trae' ? await loadTraeRules(workspaceRoot) : null;
// CLAUDE.md 仅在 claude 来源下由 loadProjectRules 纳入（决策 1 第 2 步的优先级）
```

- `none` 来源：注入用户级 + 项目级 AGENTS.md。
- `claude` 来源：注入 AGENTS.md + 项目级 CLAUDE.md（CLAUDE.md 优先于项目级 AGENTS.md，不重复拼接）。
- `trae` 来源：注入 AGENTS.md + Trae 规则（并存，AGENTS.md 为通用约束在前）。

**备选**：`trae` 来源下跳过 AGENTS.md 避免内容叠加。否决——违背「默认加载」目标；`AGENTS.md` 是通用标准文件，应始终生效，叠加风险通过来源标注缓解。

### 决策 3：Claude Skill 拆分为常驻默认加载

`extension.ts` 中 `syncSkills()` 拆分：
- **常驻默认加载**（不随 `syncSource` 变化）：`~/.claude/skills` + 项目 `.claude/skills`，去重逻辑不变（项目优先、同名不覆盖）。
- **来源绑定加载**（既有逻辑保留）：Trae Skill 目录仅在 `syncSource === 'trae'` 时加载，仍走 `syncedSkillNames` 卸载机制。
- 切源时仅卸载 Trae Skill，不再卸载常驻 Claude Skill。

### 决策 4：系统提示词支持多来源标注

`buildProjectRulesSection` 改为接收 `ProjectRules` 并以 `sources` 数组标注来源路径：

```
# 项目级规范
以下内容为项目级规范（来源：~/.claude/AGENTS.md、<workspaceRoot>/AGENTS.md），做任何开发工作都必须遵循：
```

`SystemPromptContext.projectRules` 类型随 `ProjectRules` 同步扩展。

### 决策 5：沿用既有安全护栏

- 单份文件大小上限沿用 `PROJECT_RULES_MAX_BYTES`（64KB）。
- 全局目录路径读取沿用现有 `~/.claude/...` 拼接模式（与 Skill 全局目录一致），不引入新路径校验；读取失败静默降级并记录日志（含来源路径）。

## Risks / Trade-offs

- [Trae 来源下 AGENTS.md 与 Trae 规则内容叠加] → 标注各自来源段落，模型可区分；文档提醒 AGENTS.md 为通用约束。
- [已有 CLAUDE.md 项目迁移后内容与 AGENTS.md 重复] → CLAUDE.md 优先级保持最高，重复内容不会同时注入项目级两份文件（决策 1 二选一）。
- [全局 `~/.claude/AGENTS.md` 含用户隐私] → 仅本地读取、已有结果治理脱敏、失败降级；不新增云端上传路径。
- [Skill 卸载逻辑回归（切源残留/误卸载常驻 Skill）] → Claude Skill 独立管理，Trae 仍走 `syncedSkillNames`；补充切源测试用例。
- [`projectRules` 返回结构变更影响 `systemPrompt` 调用方] → 同步更新类型与 prompt 构建，改动局限于 `projectRules.ts`/`systemPrompt.ts`/`agentLoop.ts`。

## Migration Plan

- 纯增量行为变更，无数据迁移。
- 升级后默认行为即生效；既有 claude 来源用户行为不变（CLAUDE.md 仍优先）。
- 回滚：还原 `projectRules.ts`/`agentLoop.ts`/`extension.ts` 相关改动即可。

## Open Questions

- 全局级是否同时支持 `~/.claude/CLAUDE.md` 回退（与项目级对称）？—— 本期按对称支持处理，若不需要可收敛为仅 `~/.claude/AGENTS.md`。
- 是否需要新增配置开关（如 `yunxiaoAgent.agentsMd.enabled`）允许关闭默认加载？—— 本期默认开启不提供开关，后续按需补充。
