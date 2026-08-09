# 云效 Agent 产品竞品分析与走向规划

> **文档定位**:资深 AI Agent 产品经理视角的全量竞品调研 + 差异化定位 + 产品走向规划
> **分析对象**:云效 Agent(`yunxiao-agent-vscode` v0.1.2)
> **对标竞品**:OpenCode(sst/opencode)、Claude Code、Trae(TraeCode/TraeWork)、Aider、Cursor
> **调研基准**:2026-08-09,数据来自 GitHub 仓库、官方文档、第三方测评

---

## 一、执行摘要

### 1.1 核心结论

云效 Agent 已具备一个**合格的本地 Agent Loop harness 骨架**:19 个工具、流式 SSE、上下文压缩、审批网关、执行台账、Skill 同步、JSONL 会话持久化——这套底座在开源 VSCode 插件中属于**中上水准**,安全治理(路径守卫/审批/审计/台账)甚至比部分竞品更严谨。

但在 2026 年的 harness 竞争中,**"骨架完整"已不是护城河**。对标 OpenCode/Claude Code/Trae,我们在 5 个"刚需能力"上存在明显断档:**MCP 生态、子 Agent 编排、Plan 模式、代码库语义索引、Checkpoints 回滚**。这五项是当前一线 harness 的入场券,缺任何一项都会让产品在严肃工程场景下"用不起来"。

### 1.2 产品走向建议

| 阶段 | 主题 | 核心动作 | 战略意义 |
|------|------|----------|----------|
| **Phase 1(0-3 月)** | 补齐通用 Agent 能力 | MCP + Plan 模式 + 代码库索引 + Checkpoints | 入场券,决定能否上牌桌 |
| **Phase 2(3-6 月)** | 差异化垂直楔子 | LeetCode 刷题教学模式(内置 harness 工程) | 蓝海卡位,避开与 Trae/Cursor 正面价格战 |
| **Phase 3(6-12 月)** | 扩张通用纵深 | 子 Agent + 后台任务 + CI/CD + 插件市场 | 从"工具"走向"平台" |

### 1.3 关于 LeetCode 教学模式的判断

**结论:这是一个真实存在的蓝海,但不应作为 Phase 1 主线,而应作为 Phase 2 的差异化楔子。**

理由:
1. **市场空位属实**——现有 LeetCode AI 工具(leetcode_tutor、interactive-leetcode-mcp、leetcode-teacher skill)全是"挂在通用 Agent 上的脚本/Skill",没有一家把"教学工程化"做进 harness 层(学习者画像持久化、提示阶梯、进度看板、判题闭环、错题本)。
2. **但通用能力不补齐,教学模式站不住**——教学场景强依赖:代码执行(判题)、会话记忆(学习者画像)、结构化提示(教学框架)。这些底层我们大部分已有,但**代码库索引/MCP** 缺失会让"刷题工程化"的天花板很低(无法接 OJ 平台 MCP、无法检索历史题解)。
3. **正确节奏**:通用能力补齐到"能用"即可启动 LeetCode 楔子,不必等全部补完。

---

## 二、竞品深度调研

### 2.1 OpenCode(sst/opencode,131k Star,MIT,TypeScript/Bun)

**定位**:终端原生 + 多客户端的开源 Claude Code 平替,无厂商锁定。

**架构亮点**:
- **Client-Server 架构**:后端持久化 server 进程,SDK 抽象 transport(本地 in-process / HTTP 远程),会话可跨终端断连存活。多客户端共享同一后端:CLI/TUI、Tauri 桌面、VSCode 插件、Web。
- **Plan/Build 双智能体分离**:Plan Agent 只读(需求拆解、架构设计、无写权限),Build Agent 全权限(改码、跑 bash、生成测试、Git 变更、diff 预览、一键回滚)。这是工程化分工的关键设计。
- **多子 Agent 并行**:代码检索、测试生成、文档编写、代码重构分工同步执行。
- **技术栈**:Bun + Hono HTTP + Drizzle ORM(SQLite `~/.local/share/opencode/opencode.db`)+ Vercel AI SDK。

**核心能力**:
- 75+ 模型服务商(云端 OpenAI/Claude/Gemini/Groq/OpenRouter/DeepSeek + 本地 Ollama/vLLM/llama.cpp 断网运行)
- 内置 LSP 语言解析(跨文件代码检索、重构)
- 沙箱执行 bash(隔离高危操作)
- Git 集成(自动 Commit、PR 描述、差异预览、回滚)
- 兼容 Claude Code 的 AGENTS.md 规范,Skill 脚本可直接复用
- MCP 支持
- 自定义 Commands、插件系统(oh-my-opencode 等社区生态)
- Session 持久化、SQLite 会话存储
- 工具不存储任何代码/上下文/密钥(隐私优势)

**社区生态**:Zakaria Labib 的 opencode 配置展示了"19 agents + 46 skills + 11 plugins + 12 MCP + 9 yaml workflows"的工程化堆叠,印证 OpenCode 的可扩展性极强。

### 2.2 Claude Code(Anthropic 闭源,0.20+,2026 年最成熟 Agent)

**定位**:终端原生自主 AI 编程智能体,200K-1M 超大上下文,Vibe Coding 心流编程。

**七大核心特性(2026 版)**:
1. **Agent Teams(多智能体并行)**:多个 Claude 实例各持独立上下文窗口,同时处理项目不同部分;通过共享任务列表 + 直接消息协调;Lead Agent 统筹。Anthropic 自身用 16 并行 Agent 构建了 10 万行 Rust C 编译器。
2. **Plan Mode(先思考后编码)**:结构化规划后再执行,显著提升复杂任务结果质量。
3. **Checkpoints & Rewind(无惧开发)**:自动保存状态,可随时回退实验。
4. **Custom Subagents(按需专家)**:创建专用 Agent,自带工具/提示词/权限。
5. **Skills System**:可移植复用指令,使 Claude 更懂特定流程;支持一键安装官方与社区技能。
6. **MCP Integration**:连接数据库、API、外部服务的事实标准。
7. **Background Tasks(后台任务)**:长时自主进程,释放用户注意力。

**Claude Code 2.0 关键升级**:
- Multi-Agent Orchestration(orchestrator 模式,单指令派发分析/实现/测试/PR 子任务)
- Persistent Project Memory(跨会话项目上下文,学习代码库约定/库/架构/历史决策)
- Native CI/CD(GitHub Actions/GitLab CI/Jenkins 触发,PR 自动审查/修复)
- Team Collaboration(多开发者共享实例,AI/人类建议溯源,防冲突)

**设计哲学**:无干扰(终端原生)、全流程(一个工具完成所有)、自主化、可扩展、安全可控(权限 + 沙箱)。

### 2.3 Trae(字节跳动,TraeCode + TraeWork,免费 + 订阅)

**定位**:AI 原生 IDE(VSCode fork),双模式(IDE/SOLO),中文场景优势。

**核心能力**:
- **双模式**:
  - IDE 模式:保留编辑器/终端/调试/扩展/源码控制传统工作流
  - SOLO 模式:AI 主导,自然语言/语音输入→自动规划→代码生成→测试→预览→变更总结
- **Builder 模式**:自然语言生成完整项目(前端/后端/配置/终端命令),多步 agentic 执行而非单次生成
- **CUE 补全**:代码补全、链式补全、多行编辑、下一编辑预测与导航、智能 import、智能 rename(Python/TS/Go)
- **多模型自由切换**:Claude-3.7 Sonnet / GPT-4o / DeepSeek R1 / Gemini 2.5 Pro / 豆包,免费层无需 API Key
- **多模态**:图像转代码(上传 UI 截图生成响应式 HTML/CSS)
- **Webview 实时预览**:前端即改即见(V8 热重载 ~300ms)
- **自定义智能体**:配置擅长领域 + 关联文档 + 规则引擎,团队经验沉淀为可复用智能资产
- **MCP 支持**(2026 新增)
- **AI 代码审查**:总结/审查未提交变更、单提交、分支 diff,流程图 + diff 视图
- **隐私模式**:不用于训练,代码本地
- **沙箱执行**:文件访问控制 + 高危命令拦截
- **远程开发**:Remote SSH / WSL
- **无缝迁移**:一键导入 VSCode/Cursor 配置与插件

### 2.4 Aider(git-native 开源老牌)

**定位**:git 原生的 CLI pair programmer,SEARCH/REPLACE diff 编辑模型鼻祖。
- **Architect-Editor 双模型**:强推理模型(o3/Opus)规划 + 快/便宜模型落地 diff,精调成本/质量
- **Git 原生**:每次修改自动 commit,可审计可回滚
- **Repo map**:基于 tree-sitter 的代码库地图,无需嵌入索引
- **SEARCH/REPLACE 块**:模型输出"旧代码→新代码"diff,匹配失败大声报错(防幻觉)

### 2.5 Cursor(IDE 类标杆,Agent 指挥中心)

- **三模式**:Ask(即时问答)/ Plan(先计划后执行)/ Agent(全自主多文件多步)
- **Tab 补全**:业界最流畅的下一编辑预测
- **Composer**:多文件编辑 + Agent 模式
- **/orchestrate 递归 Agent 编排**(2026.5):planner + worker + verifier 自动编排、验证、重试,降 token
- **Design Mode 可视化标注**
- **Background Agents**(云端异步)

### 2.6 横向能力对比矩阵

> ✅ 已具备 / ⚠️ 部分具备 / ❌ 缺失

| 能力维度 | 云效 Agent | OpenCode | Claude Code | Trae | Aider | Cursor |
|----------|-----------|----------|-------------|------|-------|--------|
| **Agent Loop 主循环** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **上下文压缩** | ✅ 锚定摘要 | ✅ | ✅ | ✅ | ⚠️ repo map | ✅ |
| **Doom Loop 检测** | ✅ | ✅ | ✅ | ⚠️ | ❌ | ✅ |
| **工具并发** | ✅ 3 并发 | ✅ | ✅ | ✅ | ❌串行 | ✅ |
| **Token 记账** | ✅ 四类拆分 | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| **文件工具** | ✅ 完整 | ✅ | ✅ | ✅ | ✅ | ✅ |
| **代码编辑** | ✅ diff 预览审批 | ✅ | ✅ | ✅ | ✅ SEARCH/REPLACE | ✅ |
| **终端执行** | ✅ 白名单+超时 | ✅ 沙箱 | ✅ | ✅ 沙箱 | ✅ | ✅ |
| **Git 工具** | ✅ status/log/diff/commit/branch/stash | ✅ 自动 commit | ✅ | ✅ AI commit msg | ✅ 原生 | ✅ |
| **LSP 代码智能** | ⚠️ VSCode 内置 providers | ✅ 内置 LSP | ✅ | ✅ | ⚠️ tree-sitter | ✅ |
| **代码库语义索引** | ❌ 仅 ripgrep | ✅ | ✅ 200K-1M 窗口 | ✅ | ⚠️ repo map | ✅ 嵌入索引 |
| **MCP 协议** | ❌ 仅有 spec | ✅ | ✅ | ✅ | ❌ | ✅ |
| **子 Agent / 编排** | ❌ 仅有 spec | ✅ Plan/Build | ✅ Agent Teams | ⚠️ custom agent | ❌ | ✅ /orchestrate |
| **Plan 模式** | ❌ 有 plan 事件无独立流程 | ✅ Plan Agent | ✅ Plan Mode | ✅ Builder | ❌ | ✅ Plan Mode |
| **Checkpoints / 回滚** | ⚠️ 执行台账(防重放)非全量回滚 | ✅ 一键回滚 | ✅ Rewind | ⚠️ | ✅ git 回滚 | ✅ |
| **后台 / 异步任务** | ❌ | ⚠️ server 持久化 | ✅ Background | ✅ 云端 SOLO | ❌ | ✅ Background Agents |
| **内联代码补全** | ❌ 纯对话 | ❌ | ❌ | ✅ CUE | ❌ | ✅ Tab |
| **多模态(图像)** | ❌ | ❌ | ✅ | ✅ 图生码 | ❌ | ✅ |
| **多模型切换** | ✅ OpenAI 兼容含 DeepSeek | ✅ 75+ | ❌ 仅 Claude | ✅ 多家 | ✅ | ✅ |
| **本地 / 离线** | ✅ BYO API | ✅ Ollama | ❌ | ⚠️ | ✅ | ❌ |
| **Skill 系统** | ✅ claude/trae 同步 | ✅ AGENTS.md | ✅ Skills 市场 | ✅ Rules 引擎 | ❌ | ⚠️ |
| **审批网关** | ✅ 三决策+范围授权 | ⚠️ | ✅ | ✅ 沙箱 | ⚠️ | ✅ |
| **安全审计** | ✅ 路径守卫+敏感检测+危险命令 | ⚠️ | ✅ | ✅ | ⚠️ | ✅ |
| **执行台账(幂等)** | ✅ 独有 | ❌ | ⚠️ | ❌ | ❌ | ⚠️ |
| **会话持久化** | ✅ JSONL | ✅ SQLite | ✅ | ✅ | ✅ git | ✅ |
| **跨会话记忆** | ❌ 仅单会话压缩 | ⚠️ | ✅ 学习约定 | ⚠️ | ❌ | ✅ |
| **CI/CD 集成** | ❌ | ✅ Actions | ✅ 原生 | ⚠️ | ❌ | ✅ |
| **插件扩展机制** | ❌ 仅有 spec | ✅ | ✅ Skills | ✅ 扩展店 | ⚠️ | ✅ |
| **多客户端** | ❌ 仅 VSCode | ✅ CLI/桌面/Web/VSCode | ✅ CLI/VSCode | ✅ 桌面/Web/移动 | ✅ CLI | ✅ IDE/CLI/Web |
| **中文优先** | ✅ | ❌ 英文 | ❌ 英文 | ✅ | ❌ | ❌ |
| **免费 / 开源** | ✅ 自研 | ✅ MIT | ❌ 订阅 | ✅ 免费+订阅 | ✅ Apache | ❌ 订阅 |

---

## 三、当前项目能力盘点(基于代码探索)

> 以下为对 `yunxiao-agent-vscode` 代码库的全量探索结论,作为差距分析的事实基线。

### 3.1 已具备能力(在开源 VSCode 插件中属中上水准)

| 模块 | 能力 | 评价 |
|------|------|------|
| **工具层(19 个)** | fs(6)+ code(5)+ terminal(1)+ git(6)+ skill(1),统一 BaseTool 契约 | 覆盖完整,代码智能用 VSCode 内置 providers |
| **结果治理** | 二进制脱敏、密钥脱敏、行/字节/字符三重截断 | 比多数竞品严谨 |
| **安全治理** | pathGuard(越界/符号链接/敏感文件)、approvalGateway(三决策+范围授权 24h)、securityAudit、toolExecutionJournal(幂等防重放) | **独有亮点**,工程化程度高于 OpenCode |
| **Agent Loop** | 每轮重载历史、maxSteps、空回复兜底、上下文溢出恢复、doom loop 检测、3 并发工具 | 主循环健壮 |
| **压缩** | 锚定摘要(keepTokens/buffer/contextWindow)、工具调用链边界保护、首次/增量两套 prompt | 设计成熟 |
| **会话持久化** | JSONL + index.json、原子落盘、坏行容忍、惰性加载、变更订阅 | 比 vscdb 更可移植 |
| **LLM 层** | OpenAI 兼容、DeepSeek 思考链适配、SSE 流解析 | 多模型友好 |
| **Skill 同步** | claude/trae 双来源、热生效、串行链防错乱 | 生态复用 |
| **Webview** | 流式渲染、Markdown、思维链、审批卡片、diff 预览、历史列表、斜杠命令、@文件、Token 看板 | 功能完备 |
| **测试** | mocha + vscode-test,358 测试通过 | 覆盖良好 |

### 3.2 已规划但未实现(spec 存在,代码缺失)

> `openspec/specs/` 共 36 个 spec,以下为"有 spec 无实现"的关键项:

- **MCP 生态**(spec: 无独立 spec,但 docs/ 有 13-MCP生态设计)
- **多 Agent 与任务树**(spec: session-orchestration;docs: 10-多Agent与任务树)
- **插件扩展机制**(spec: 无;docs: 14-插件扩展机制)
- **inline webview diff 预览**(diffViewer 注释标注留 Phase 5)
- **budget_update / budget_exhausted 事件**(类型已定义无发射点)
- **跨会话执行记忆**(docs: 00-跨会话执行记忆)

### 3.3 明确的能力断档

经代码探索确认,以下能力**既无实现也无 spec**:

1. 代码库语义索引(嵌入索引/代码图谱)
2. Plan 模式(独立 plan→confirm→execute 流程,现有 plan 事件仅展示无门控)
3. Checkpoints/快照/全量回滚(执行台账只防工具重放,不支持状态回退)
4. 后台/异步任务
5. 内联代码补全(Tab 补全)
6. 多模态输入(图像)
7. CI/CD 集成(GitHub Actions 等)
8. 跨会话持久记忆(学习代码库约定)
9. 多客户端(CLI/桌面/Web)
10. 自定义 Agent 构建器 UI

---

## 四、能力差距分析(通用 Agent 能力补齐)

> 按"对严肃工程场景的阻塞程度"排序,P0 为不补齐就无法上牌桌。

### 4.1 P0 - 入场券级断档

#### 4.1.1 MCP 协议支持 ❌

**差距**:MCP(Model Context Protocol)已成为 2026 年连接外部工具(DB/Issue Tracker/浏览器/API)的事实标准,Claude Code/OpenCode/Trae/Cursor 全部支持。我们仅 docs 有设计,无实现。

**阻塞场景**:
- 无法接 GitHub/Slack/Notion 等外部服务(企业协作场景废)
- 无法接数据库 MCP(数据开发场景废)
- 无法复用社区数百个 MCP server 生态

**建议实现**:
- 在 `src/mcp/` 新增 MCP client(遵循 MCP 协议规范,stdio + SSE transport)
- MCP server 注册为工具(动态注入 ToolRegistry)
- 配置项 `yunxiaoAgent.mcp.servers`(JSON 数组,server 名/command/args/env)
- 走现有 toolRouter 的审批/治理链路(MCP 工具默认 write 权限需审批)
- 优先支持 stdio transport,SSE 可后置

#### 4.1.2 Plan 模式(独立 plan→confirm→execute)❌

**差距**:现有 `plan` 事件仅用于 UI 展示模型自发的计划,无"先只读规划→用户确认→再执行"的门控流程。Claude Code/Cursor/OpenCode 均有独立 Plan 模式。

**阻塞场景**:
- 复杂重构/迁移任务无前置规划,直接动手易跑偏(用户无法在执行前纠偏)
- 大改动缺乏"计划审计"环节,信任成本高

**建议实现**:
- AgentLoop 增加 `mode: 'plan' | 'execute'`
- Plan 模式:toolChoice 限制为只读工具(fs.read/list/search、code 读取类、git 读取类),输出结构化计划(TodoWrite + 步骤说明)
- Webview 增加"计划确认"卡片(展示步骤 + 修改 + 批准/拒绝)
- 批准后切 execute 模式,按计划执行,每步可暂停
- 复用现有 EventBus 的 `plan` 事件

#### 4.1.3 代码库语义索引 ❌

**差距**:当前 `fs.search_files` 仅 ripgrep 文本搜索,无语义检索。竞品均有:OpenCode 内置 LSP、Cursor 嵌入索引、Claude Code 靠超大窗口、Aider 用 tree-sitter repo map。

**阻塞场景**:
- "找出所有处理支付的模块"这类语义查询无法命中
- 大型代码库相关文件发现靠 grep,召回率低
- 模型选型受限(无索引时必须用大窗口贵模型)

**建议实现**(渐进式,先轻后重):
- **L1(优先)**:tree-sitter 生成 repo map(符号表 + 依赖关系),类似 Aider,低成本高收益
- **L2**:VSCode workspace symbols 已用,补强 find_references 的传递闭包(调用链分析)
- **L3(后置)**:本地嵌入索引(如 sqlite-vss 或 lanceDB),分块向量化,语义检索 top-k

#### 4.1.4 Checkpoints / 全量回滚 ⚠️→❌

**差距**:现有 `toolExecutionJournal` 只防非幂等工具重放,不支持"回退到某个时间点的完整工作区状态"。Claude Code 的 Rewind、OpenCode 的一键回滚均为标配。

**阻塞场景**:
- Agent 一系列改动后用户发现方向错了,无法整体回退(只能手动 git checkout 或逐个撤销)
- 实验性任务无"安全网",用户不敢让 Agent 大胆执行

**建议实现**:
- 结合 Git:每次 Agent run 开始前若在 git repo,自动创建轻量 stash checkpoint(或临时 commit)
- Webview 增加"历史检查点"列表,支持回退到指定检查点
- 非 git 场景:记录 affected_files 的 before/after 内容快照(复用 fileVersion.ts 的哈希机制)

### 4.2 P1 - 竞争力级断档

#### 4.2.1 子 Agent / 多 Agent 编排 ❌

**差距**:Claude Code Agent Teams、OpenCode Plan/Build、Cursor /orchestrate 均支持多 Agent 分工。我们仅 spec 无实现。

**建议实现**(分两步):
- **Step1 主子 Agent**:主 Agent 可 spawn 子 Agent(独立上下文窗口),子 Agent 完成特定子任务后返回结果摘要。适用于:大任务拆解、并行独立子任务。
- **Step2 Agent Teams**:多 Agent 共享任务列表 + 消息通道(参考 Claude Code)。复杂度高,建议 Phase 3。

#### 4.2.2 跨会话持久记忆 ❌

**差距**:会话内压缩已有,但跨会话的"项目约定学习"缺失。Claude Code 2.0 的 Persistent Project Memory 是核心卖点。

**建议实现**:
- 在 `~/.yunForce/projects/<ws>/` 下增加 `memory.md`(项目级)与 `profile.md`(用户级)
- AgentLoop 周期性提取"Always X / Decision Y / Convention Z"写入 memory
- 系统提示词注入 memory 段(类似 projectRules 注入)
- 参考 Zakaria/opencode 的 memory-context 插件模式

#### 4.2.3 后台 / 异步任务 ❌

**差距**:长任务(大规模重构、测试套件运行)阻塞 UI。Claude Code Background Tasks、Cursor Background Agents、Trae 云端 SOLO 均支持。

**建议实现**:
- 任务队列 + 后台 worker(VSCode 进程内或独立子进程)
- Webview 任务面板(进行中/已完成/结果查看)
- 通知机制(完成时 VSCode notification)

### 4.3 P2 - 体验级断档(非阻塞但影响竞争力)

| 能力 | 差距描述 | 建议优先级 |
|------|----------|-----------|
| **内联代码补全** | 纯对话,无 Tab 补全;Cursor/Trae 核心体验 | P2(工作量大,需 InlineCompletionItemProvider) |
| **多模态输入** | 无图像输入;Trae 图生码、Claude 多模态 | P2 |
| **CI/CD 集成** | 无 GitHub Actions 触发 | P2 |
| **插件扩展机制** | 第三方无法扩展;OpenCode/Claude 生态丰富 | P2 |
| **多客户端** | 仅 VSCode;OpenCode 多端、Trae 移动端 | P3 |
| **AI 代码审查** | 无独立审查流;Trae 有 flowchart + diff | P2 |

---

## 五、产品差异化定位分析

### 5.1 现有差异化基础(已具备,需放大)

| 差异点 | 现状 | 放大建议 |
|--------|------|----------|
| **VSCode 原生插件(非 fork)** | 无需换 IDE,轻量 | 对比 Trae/Cursor 的 fork 重模式,主打"零迁移成本" |
| **本地优先 + BYO 模型** | OpenAI 兼容含 DeepSeek 思考链 | 对比 Claude Code 锁定 Anthropic,主打"模型自由 + 离线可用" |
| **安全治理深度** | pathGuard + 审批网关 + 执行台账 + 审计 | 独有的"执行台账防重放"是合规场景卖点(金融/政企) |
| **中文优先** | 系统提示词/注释/UI/文档全中文 | 国内市场卡位,对标 Trae 但更轻量 |
| **Skill 生态同步** | claude/trae 双来源 | 复用两大生态 Skill,零成本内容 |

**判断**:现有差异化是"防御性差异"(让现有用户不流失),但不是"进攻性差异"(让新用户选我们而非竞品)。需要进攻性楔子。

### 5.2 LeetCode 刷题教学模式 - 蓝海深度分析

#### 5.2.1 市场空位验证

**现有竞品全景**:

| 产品 | 形态 | 教学工程化程度 | 关键缺失 |
|------|------|---------------|----------|
| **leetcode_tutor**(swapniel99) | 独立 Python 脚本 + Gradio | 低:单会话,进度靠 session log 文件 | 无持久学习者画像、无判题闭环、无提示阶梯 |
| **interactive-leetcode-mcp**(SPerekrestova) | Claude Code 的 MCP server | 中:有 learning mode、判题、提交历史 | 依赖 Claude Code,非 harness 原生;无课程结构 |
| **leetcode-teacher skill**(LobeHub) | Claude Code Skill | 中:苏格拉底式、Make It Stick 框架、六段式教学 | 纯提示词 Skill,无工具支撑;单会话(需 SessionStart hook 才跨会话) |
| **通用 Agent 刷题** | Claude Code/Trae 直接问 | 低:无教学约束,易直接给答案 | 无"教学模式",违背学习目标 |

**核心洞察**:
> **没有一个 harness 框架把"刷题教学"做进工程层。** 现有方案全是"通用 Agent + 教学提示词/Skill"的叠加,共同缺陷:
> 1. 无持久学习者画像(薄弱点/掌握模式/历史题解)
> 2. 无结构化课程(按专题/难度/薄弱点出题)
> 3. 无判题闭环(本地或在线 OJ 集成)
> 4. 无提示阶梯(渐进式 hint,而非直接给答案)
> 5. 无错题本/复习调度(间隔重复)
> 6. 无进度看板(可视化学习轨迹)

这是真实的蓝海:**harness 原生的刷题教学工程**。

#### 5.2.2 我们的适配优势

| 教学需求 | 我们已有能力 | 缺口 |
|----------|-------------|------|
| 代码执行/判题 | ✅ terminal.exec(白名单 + 超时) | 需补:LeetCode 题目拉取工具、测试用例 runner、复杂度分析 |
| 学习者画像持久化 | ✅ JSONL 会话存储 + 项目级目录 | 需补:画像数据结构、提取逻辑 |
| 结构化教学提示 | ✅ systemPrompt + Skill 系统 | 需补:教学 Skill(苏格拉底式 + 六段式) |
| 渐进式 hint | ✅ 多轮对话 | 需补:hint 分级机制 |
| 进度看板 | ✅ Webview + Token 看板经验 | 需补:学习进度可视化 |
| 错题本 | ✅ 文件工具 | 需补:错题存储 + 间隔重复调度 |
| 多语言判题 | ✅ terminal.exec 支持任意命令 | 基本够用 |

**结论**:我们比任何竞品都更接近"教学 harness"——底层 80% 已就绪,只需补 20% 教学专用层。

#### 5.2.3 LeetCode 教学模式产品设计

**新增工具(教学专用)**:
1. `leet.fetch_problem` - 拉取 LeetCode 题目(描述/约束/示例/模板代码),支持题号/题名/URL
2. `leet.run_solution` - 本地运行解法 + 测试用例,返回通过率/运行时/内存/失败用例
3. `leet.submit` - (可选)提交至 LeetCode 在线判定(需 cookie)
4. `leet.analyze_complexity` - 静态分析时间/空间复杂度(或调 LLM 推理)
5. `leet.get_hint` - 按级别返回提示(不直接给答案)

**新增 Skill(教学框架)**:
- `leetcode-teacher` Skill:苏格拉底式教学 + 六段式结构(直觉→暴力→最优→复杂度→编码→反思)+ Make It Stick(检索练习/交错/精细化)+ 提示阶梯(L1 方向/L2 思路/L3 伪代码/L4 解答)

**持久学习者画像**(`~/.yunForce/leetcode/profile.json`):
- 掌握度矩阵:按专题(数组/DP/图/树…)× 难度(Easy/Medium/Hard)记录正确率
- 薄弱点标签:如"滑动窗口边界处理弱"
- 历史题解:每题的多版本解法 + 复杂度 + 反思
- 学习节奏:间隔重复调度(错题 N 天后重练)

**Webview 教学面板**:
- 进度看板(掌握度热力图)
- 错题本
- 今日推荐(按薄弱点出题)
- 教学模式开关(开启后 Agent 走教学提示,不直接给答案)

**教学流程**:
```
用户:刷一道滑动窗口 Medium
→ leet.fetch_problem(随机/指定薄弱点)
→ 进入教学 Skill:先问"你打算怎么枚举?"
→ 用户回答 → leet.get_hint(L1 方向性提示)
→ 用户编码 → leet.run_solution 判题
→ 失败 → 教学式 debug(问"哪一步你觉得有问题?")
→ 通过 → leet.analyze_complexity + 反思问答
→ 更新学习者画像
```

#### 5.2.4 风险与边界

| 风险 | 应对 |
|------|------|
| LeetCode ToS 限制爬取 | 优先用 LeetCode 公开 GraphQL API(需登录态),或只拉题目描述不拉测试用例(用户自备) |
| 教学模式与通用模式割裂 | 教学模式作为"子 Agent / Skill 模式"叠加,不破坏通用 harness |
| 判题环境复杂(多语言) | L1 支持 Python/JS/TS(覆盖大多数刷题者),其他语言渐进 |
| 投入产出比 | Phase 2 启动,先 MVP(题目拉取 + 教学提示 + 本地判题 + 画像),看用户反馈再扩展 |

### 5.3 差异化战略结论

**三层差异化组合**:

1. **防御层(已有,放大)**:VSCode 原生 + 本地优先 + 安全治理深度 + 中文优先
   - 目标:守住开源 VSCode 插件赛道

2. **进攻层(Phase 2 建设)**:LeetCode 刷题教学 harness
   - 目标:在"学习/教学"场景建立心智,避开与 Trae/Cursor 的通用开发正面战
   - 受众:校招学生、面试备战者、算法竞赛选手(国内年新增百万级)

3. **平台层(Phase 3 建设)**:MCP + 插件生态 + 多 Agent
   - 目标:从工具走向平台,允许社区构建垂直场景(刷题只是第一个垂直楔子)

**为什么 LeetCode 是好的楔子**:
- 场景明确(刷题)、用户高频(每日)、痛点清晰(没人教/没人改/没画像)
- 技术复用度高(80% 复用现有 harness)
- 可验证(判题通过率 = 价值证明)
- 易传播(刷题社群 + 高校)
- 可延伸(算法→系统设计→面试模拟→其他 OJ)

---

## 六、产品走向与优先级规划

### 6.1 路线图总览

```
Phase 1 (0-3 月): 补齐通用 Agent 能力 —— "上牌桌"
├─ P0-1 MCP 协议支持
├─ P0-2 Plan 模式(独立 plan→confirm→execute)
├─ P0-3 代码库语义索引(L1: tree-sitter repo map)
└─ P0-4 Checkpoints / 全量回滚

Phase 2 (3-6 月): LeetCode 教学楔子 —— "建心智"
├─ 教学专用工具(leet.fetch/run/analyze/hint)
├─ leetcode-teacher Skill(苏格拉底 + 六段式)
├─ 学习者画像持久化
├─ 教学模式 Webview 面板
└─ (并行)跨会话持久记忆(通用能力,也服务于教学)

Phase 3 (6-12 月): 平台化扩张 —— "做生态"
├─ 子 Agent / 多 Agent 编排
├─ 后台 / 异步任务
├─ 插件扩展机制
├─ CI/CD 集成
└─ (可选)内联补全 / 多模态
```

### 6.2 Phase 1 详细任务(P0 入场券)

> 每项均给出实现入口与验收标准,可直接进入实施。

#### P0-1 MCP 协议支持
- **入口**:新建 `src/mcp/`(mcpClient.ts / mcpRegistry.ts / mcpToolAdapter.ts)
- **配置**:`yunxiaoAgent.mcp.servers`(JSON: name/command/args/env/transport)
- **集成**:MCP server 的 tools 动态注册到 ToolRegistry,走 toolRouter 审批治理
- **验收**:能配置一个 stdio MCP server(如 filesystem MCP),Agent 可调用其工具

#### P0-2 Plan 模式
- **入口**:`src/agent/agentLoop.ts` 增加 mode 分支;`src/agent/planMode.ts` 新建
- **流程**:Plan 模式 toolChoice 限只读 → 输出 TodoWrite + 步骤 → Webview 确认卡片 → execute 模式按步执行
- **验收**:复杂任务可先出计划,用户确认后才改文件

#### P0-3 代码库语义索引(L1)
- **入口**:新建 `src/indexing/repoMap.ts`,用 tree-sitter 生成符号表 + 依赖图
- **工具**:新增 `code.repo_map`(read,返回结构化符号概览)
- **注入**:系统提示词注入精简 repo map(类似 Aider)
- **验收**:Agent 回答"项目结构"类问题准确度显著提升

#### P0-4 Checkpoints
- **入口**:`src/core/checkpointManager.ts` 新建;结合 git stash / 文件快照
- **UI**:Webview 历史检查点列表 + 回退按钮
- **验收**:Agent run 后可一键回退到 run 前状态

### 6.3 Phase 2 详细任务(LeetCode 楔子)

> 见 §5.2.3,此处给优先级:
1. **MVP(4 周)**:`leet.fetch_problem` + `leet.run_solution` + leetcode-teacher Skill + 基础画像
2. **完整(8 周)**:hint 阶梯 + 复杂度分析 + 进度看板 + 错题本 + 间隔重复

### 6.4 关键假设与决策点

| 假设 | 验证方式 | 风险 |
|------|----------|------|
| LeetCode 教学有真实需求 | Phase 2 MVP 后看留存/口碑 | 低(MVP 成本小) |
| MCP 是企业场景刚需 | Phase 1 后看 issue/用户反馈 | 低(竞品全支持) |
| tree-sitter repo map 够用 | 对比 L3 嵌入索引的召回率 | 中(大库可能不够) |
| 用户愿意 BYO 模型(非免费模型) | 看用户增长 vs Trae 免费 | 中(Trae 免费层是威胁) |

### 6.5 不做什么(明确排除)

- **不做 IDE fork**:坚持 VSCode 插件形态,不与 Trae/Cursor 正面竞争重模式
- **不做自研模型**:专注 harness,模型层保持 BYO
- **不做云端托管**(Phase 3 前):本地优先是差异化,不轻易上云
- **不做内联补全**(Phase 3 前):工作量大且非差异化,Tab 补全让位 Cursor

---

## 七、验证步骤

本报告为分析交付物,无代码改动需验证。后续若进入实施:

1. **Phase 1 每项**:实现后跑 `npm run compile`(类型 + lint)+ `npm test`(358 测试不回归)+ 手动验收标准
2. **Phase 2 MVP**:刷 5 道题验证教学闭环跑通,学习者画像正确持久化
3. **竞品复查**:每季度重新对照本矩阵,更新差距

---

## 附录 A:信息来源

- **OpenCode**:[sst/opencode GitHub](https://github.com/sst/opencode)、[SofaGenius PR#92 深度分析](https://github.com/lilyzhng/SofaGenius/pull/92)、[CSDN OpenCode 详解](https://deepseek.csdn.net/6a319a2110ee7a33f27e1fd1.html)、[Zakaria/opencode 配置](https://github.com/Zakarialabib/opencode)
- **Claude Code**:[CSDN 2026 详解](https://blog.csdn.net/zsh_1314520/article/details/160104013)、[Jordan James Media 7 特性](https://jordanjamesmedia.com/clients/claude-code/pdfs/00-claude-code-overview.pdf)、[Claude Code 2.0 发布](https://claude5.ai/en/news/anthropic-claude-code-v2-agentic-features-launch)
- **Trae**:[Trae 官方文档](https://docs.trae.ai/ide/what-is-trae)、[bytedance/trae-agent GitHub](https://github.com/bytedance/trae-agent)、[ToolWorthy 评测](https://www.toolworthy.ai/tool/trae)、[lowcode.agency 对比](https://www.lowcode.agency/blog/claude-code-vs-trae)
- **LeetCode 教学**:[leetcode_tutor](https://github.com/swapniel99/leetcode_tutor)、[interactive-leetcode-mcp](https://github.com/SPerekrestova/interactive-leetcode-mcp)、[leetcode-teacher skill](https://lobehub.com/ar/skills/luqmannurhakimbazman-ashford-leetcode-teacher)、[shadecoder 2026 指南](https://articles.shadecoder.com/what-is-ai-leetcode-practice-tool-complete-guide-for-2026)
- **横向对比**:[youngju.dev 2026 对比](https://www.youngju.dev/blog/culture/2026-05-14-ai-coding-agent-comparison-2026-claude-code-cursor-codex-copilot-openclaw-deep-dive-guide-2026)、[CSDN 全景解析](https://blog.csdn.net/yanceyxin/article/details/162586505)
- **本项目**:代码库全量探索(19 工具 / agent / core / memory / llm / skill / chatPanel / 36 specs / docs)
