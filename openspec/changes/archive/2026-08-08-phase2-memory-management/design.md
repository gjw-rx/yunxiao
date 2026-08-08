## Context

Phase 1（模型连接层）已完成，`src/llm/types.ts` 定义了 `LLMMessage`（system/user/assistant/tool）和 `LLMProvider` 接口。当前会话历史仍由云端 `SessionManager`（v2 Run API）管理，无本地存储。Phase 2 需要新建本地记忆管理模块，为 Phase 3 Agent Loop 提供消息存储和历史加载能力。

现有 EventBus 已定义 `token_usage`、`error`、`stream_end` 等事件类型，记忆管理模块不需要新增事件类型。

## Goals / Non-Goals

**Goals:**
- 定义本地消息类型，支持 seq 序号、attachments、toolCalls、compaction 检查点
- 实现 MessageStore：内存存储 + VSCode workspaceState 持久化
- 实现历史加载器：从 compaction 检查点加载并转换为 `LLMMessage[]`
- 每个 session 最多 1000 条消息

**Non-Goals:**
- 不引入 SQLite（使用 VSCode 原生 workspaceState）
- 不实现事件溯源（简化为消息列表存储）
- 不实现跨工作区共享（单工作区即可）
- 不实现消息加密
- 不实现 compaction 生成逻辑（Phase 5 负责，Phase 2 只负责存储和加载 compaction 消息）

## Decisions

### 1. 消息类型带 seq 序号

每条消息分配递增的 `seq` 序号，用于 `deleteMessagesAfter` 回退操作和 compaction 检查点定位。

**替代方案**：用数组索引代替 seq。**否决理由**：数组索引在 delete 操作后会变化，无法稳定引用消息位置。

### 2. CompactionMessage 携带 recentContext

CompactionMessage 存储 `summary`（摘要文本）和 `recentContext`（压缩时保留的近期消息原文数组）。历史加载时，compaction 消息转为 system 消息（含 summary），recentContext 展开为原有消息。

**替代方案**：compaction 只存 summary，recent 存为独立消息。**否决理由**：compaction 作为检查点需要原子性，summary + recentContext 封装在单条消息中更清晰。

### 3. 持久化使用 workspaceState JSON 序列化

`workspaceState` 存储 `Map<sessionId, Message[]>` 的 JSON 序列化结果，key 为 `yunxiaoAgent.messages`。每次 `append` 后自动 persist。

**替代方案**：使用 globalState 跨工作区共享。**否决理由**：Non-Goal 明确单工作区即可，globalState 会引入跨工作区数据污染风险。

### 4. 历史加载从最新 compaction 检查点开始

`loadHistoryForLLM` 查找最新的 CompactionMessage，返回 `[compaction_as_system, ...messages_after_compaction]`。无 compaction 时返回全部消息。

**替代方案**：总是返回全部消息。**否决理由**：长对话会超出上下文窗口，compaction 检查点是 Phase 5 自动压缩的基础。

### 5. Message 消息类型与 LLMMessage 分离

`src/memory/types.ts` 的 `Message` 带 `seq` 和 `attachments`，`src/llm/types.ts` 的 `LLMMessage` 不带。HistoryLoader 负责转换：丢弃 seq，将 attachments 内联为文本，将 CompactionMessage 转为 system 消息。

**理由**：存储层需要 seq 管理顺序，LLM 层不需要。分离避免 LLM 类型被存储细节污染。

### 6. workspaceState 持久化由 Memento 注入

MessageStore 构造函数接收 `vscode.Memento` 参数（workspaceState），而非直接 import vscode。便于测试时注入 mock。

## Risks / Trade-offs

- **workspaceState 存储大小限制**：VSCode workspaceState 有大小限制（约 100MB），1000 条消息可能接近上限。-> 缓解：每消息内容截断到合理长度（由调用方负责），workspaceState 写入失败时降级为纯内存模式并记录日志。
- **JSON 序列化性能**：每次 append 都全量序列化整个 Map，消息量大时可能慢。-> 缓解：1000 条消息的序列化在毫秒级，可接受；如未来成为瓶颈可改为增量持久化。
- **并发写入**：多个 Agent Loop 同时写同一 session 理论上可能冲突。-> 缓解：当前单工作区单 Agent Loop 设计，不会并发；类型签名上 append 是同步操作。
