## Context

云效 Agent 插件当前是一个**纯聊天面板**：`ChatViewProvider`（webview view）通过 `AIClient` 向云端 `POST /api/agent/invoke/message/stream` 发起 SSE 流，`handleSseBlock` 解析 4 类事件（`content` / `thought` / `tool_start` / `tool_end`）与 `{success:false}` 错误信封。云端 Agent（独立仓库 `D:\python_project\ai_training`，FastAPI + LangGraph）负责全部决策与工具执行，本地无法触及用户工作区。

目标是演进为类 Claude Code 的「混合编排」架构：云端 Agent 决策，本地工具执行，结果回传续流。Phase 1 只交付**最小可运行闭环**--跑通只读工具 `fs.read_file`，把协议层与本地基础设施的根基打牢。本设计聚焦**本地侧**的实现架构与跨端协议决策；云端侧的具体代码改动见 `docs/整体架构计划/Phase1改动计划.md`。

约束：
- 不破坏现有聊天流程（无 `local_tools` 时退化为纯聊天）。
- 不引入写操作、审批、终端、git、diff--这些属 Phase 2+。
- Phase 1 全部用 Node 内置 + VSCode API，不新增 npm 依赖。
- `path-guard` 为安全关键（CRITICAL），必须有单测覆盖越界场景。

## Goals / Non-Goals

**Goals:**
- 在本地建立可扩展的工具基础设施：类型契约、注册表、路径守卫、基类、会话状态机。
- 打通「云端 `tool_call` -> 本地执行 -> `/tool_result` 回传 -> 续流」端到端链路。
- 首个本地工具 `fs.read_file` 可用，且只读、无需审批。
- 与云端协议解耦：云端未就绪时可用 mock 跑通本地链路。

**Non-Goals:**
- 写文件 / 编辑 / diff / 终端 / git / 代码索引（Phase 2+）。
- 审批网关与权限矩阵（Phase 2）。
- Webview 组件化重构、工具调用卡片精细 UI（Phase 5；Phase 1 仅最小展示工具状态）。
- 批量并行工具调用 `tool_call_batch`（可选优化，后续阶段）。

## Decisions

### 决策 1：采用「混合编排」而非「本地全编排」或「云端全编排」
云端已有成熟的 Agent 框架（skill/mcp/tool 装配、LangGraph checkpointer、记忆），本地全编排意味着用 TS 重写这套东西，违反 DRY/YAGNI；云端全编排则需把用户工作区文件内容来回传输，既不安全又浪费 token。混合编排复用云端决策能力，本地仅执行必须本地化的操作（文件/终端/git），与 Claude Code 本身架构一致。
- **备选**：本地全编排（放弃云端框架，重造轮子）--否决；云端全编排（每次传文件内容）--否决。

### 决策 2：续流采用「流中断 + HTTP 回传 + 内部续流」，不引入 WebSocket
云端推送 `tool_call` 后 SSE 流自然 end；本地执行工具后 `POST /tool_result`；云端重新 `ainvoke` 并发起新 SSE 流。前端把「用户发消息」与「回传工具结果」都视为触发新一轮 SSE 流的入口。
- **理由**：复用现有 SSE 解析逻辑；无需 WebSocket 双向连接；失败/超时用 HTTP 响应码处理，语义清晰；多客户端协议一致。
- **备选**：WebSocket 双向通道--否决（复杂度高，现有架构无 WS）。

### 决策 3：本地工具 schema 经会话创建上报（方案 A），而非独立拉取接口
创建会话时 `POST /api/agent/invoke/session` body 增加可选 `local_tools` 字段，云端装配时合并到工具集。
- **理由**：减少一次 round trip；会话与工具天然绑定（该会话期间工具集固定）；无 `local_tools` 时向后兼容。
- **备选**：独立 `GET /api/agent/tools/local` 拉取--否决（多一次请求，且工具与会话生命周期分离）。

### 决策 4：从 `aiClient.ts` 抽出 SSE 解析为独立 `sseHandler.ts`
当前 `handleSseBlock` 内联在 `aiClient.ts`，只处理 4 类事件且不可扩展。抽出为 `src/protocol/sseHandler.ts`，按事件类型分发到事件总线，新增 `tool_call` / `plan` / `progress`，保留原 4 类。`aiClient.streamMessage` 改为调用 handler，回调扩展 `onToolCall` / `onPlan` / `onProgress`，原回调签名不变。
- **理由**：单一职责；后续 Phase 5 UI 重构可直接订阅事件总线而非穿透回调。

### 决策 5：`path-guard` 作为所有文件工具的强制前置校验
任何 `fs.*` 工具在 `execute` 前必须先经 pathGuard 解析路径并校验。pathGuard 负责工作区根解析、`..` 越界拦截、符号链接 realpath 校验、Windows/Unix 路径规范化、敏感文件标记。
- **理由**：路径遍历是 CRITICAL 安全风险，集中守卫避免散落各工具；单测可集中覆盖。
- **备选**：各工具自行校验--否决（易遗漏、不一致）。

### 决策 6：会话状态机协调多轮 SSE 流
一次用户输入可能触发多轮 SSE 流（每轮含一个工具调用）。`sessionManager` 维护 `sessionId -> {pendingToolCalls, abortController, history}`，状态机驱动：流开始 -> 收到 `tool_call` -> 流结束 -> 执行工具 -> 回传 -> 续流开始 -> ... -> 最终 `content` 流结束。工具调用生命周期 pending/running/success/error 可被 UI 查询。
- **理由**：多轮协调是 Phase 1 的核心难点（Medium 风险），显式状态机比散落的回调可靠。

### 决策 7：`fs.read_file` 为首个工具，只读、无需审批
首个工具选择只读操作，验证端到端协议且风险最低（无审批网关、不修改文件系统）。包含大小限制（默认 1MB）、二进制检测、敏感文件脱敏。
- **理由**：先跑通闭环再叠加高风险能力；与架构规划 Phase 1 验证标准一致（「读一下 src/extension.ts 并总结」）。

### 决策 8：内部事件总线解耦 SSE / 工具 / UI
引入 `src/core/eventBus.ts`，SSE handler、工具执行器、会话状态机均通过事件总线通信，`chatPanel.ts` 订阅事件更新 UI。
- **理由**：避免回调穿透；Phase 5 UI 重构时可平滑迁移；工具调用状态变更可多处订阅。
- **备选**：直接回调链--否决（Phase 5 重构成本高）。

## Risks / Trade-offs

- **[云端协议扩展需联调]** -> Phase 1 优先与云端团队对齐协议（见 `Phase1改动计划.md`），本地先用 mock 云端跑通，再联调。`tool-call-protocol` spec 即为对齐契约。
- **[路径遍历攻击]**（Critical）-> pathGuard 强制前置 + 集中单测覆盖 `../../../etc/passwd`、工作区外绝对路径、符号链接、Windows/Unix 差异。
- **[多轮续流状态正确性]**（Medium）-> 显式状态机 + 状态转换单测；超时与取消必须发 `cancelled`/`error` 结果，避免云端死等。
- **[SSE 半包缓冲]**（Low）-> sseHandler 按 `\n\n` 分隔事件、保留跨块 buffer，复用现有解析模式。
- **[敏感文件泄露]**（High）-> pathGuard 标记 + read_file 脱敏 + 用户警告；Phase 1 不返回原始密钥内容。
- **[向后兼容]**（Low）-> `local_tools` 可选；无该字段时云端与本地均退化为纯聊天，现有用户无感。

## Migration Plan

1. **本地先行（mock 云端）**：实现 1.1-1.8 全部本地模块；用本地 mock SSE（发出 `tool_call` 并接收 `/tool_result`）跑通最小闭环单测与手动验证。
2. **云端对齐**：云端按 `Phase1改动计划.md` 实现 `tool_call` 事件、`/tool_result` 端点、`local_tools` 合并、续流。
3. **联调**：本地切换到真实云端，跑通「读 src/extension.ts 并总结」端到端。
4. **回滚**：本地通过配置开关关闭工具调用（不发 `local_tools`），即回退为纯聊天；云端 `local_tools` 缺省时行为不变，无需回滚。

## Open Questions

- 云端 `tool_call` 事件的确切发射点（LangGraph tool node 内识别 `site: local` 后 yield）需在 `Phase1改动计划.md` 落实并联调验证。
- 续流时云端如何复用同一 checkpointer thread 以保留完整工具调用历史--待云端确认（见 `Phase1改动计划.md`）。
- Phase 1 是否需要「工具调用最小 UI 卡片」：建议只做文本态状态展示（pending/running/success/error），精细卡片留 Phase 5。
