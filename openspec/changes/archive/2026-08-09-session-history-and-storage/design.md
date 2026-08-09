# Design: session-history-and-storage

## Context

现状：`MessageStore` 用 VSCode `workspaceState`（`state.vscdb`）持久化，key=`yunxiaoAgent.messages`，结构为 `Record<sessionId, Message[]>`；`LocalSessionManager` 管理 `sessionId` 映射并提供 `createSession`/`loadHistory`/`reset`/`setCurrentSessionId`；`chatPanel.ts` 的 `createSession` 消息处理会 `reset()` 旧会话（清空历史）。前端 webview 已有 `sessionCreated`/`historyLoaded` 消息契约与 `currentSessionId` 内部状态。`historyLoader.ts` 从 `MessageStore` 读取历史供 LLM 使用（compaction 感知），不关心存储介质。

约束：TypeScript strict、不新增依赖、工具与核心模块通过接口解耦、所有关键步骤打日志（`src/logger.ts`）、函数带中文 JSDoc。

## Goals / Non-Goals

**Goals:**
- 会话消息持久化到用户可见、可备份的文件存储（`~/.yunForce/projects/<workspace 编码>/`），JSONL 追加写
- 新建会话保留旧会话（历史永存，仅切换当前指针）
- 提供会话列表（索引）、回放、继续对话（resume）、删除
- `MessageStore`/`HistoryLoader`/`AgentLoop` 接口不变，改动最小化
- 旧 workspaceState 数据一次性迁移

**Non-Goals:**
- 不做跨设备同步、不做全文搜索、不做 SQLite 数据库
- 不存储/展示 reasoning 思考文本（现状即未存储）
- 不做会话归档/导出/导入

## Decisions

### D1. 存储位置与格式：`~/.yunForce/projects/<ws 编码>/<sessionId>.jsonl`

复刻 Claude Code 结构。目录名 = workspace 根绝对路径做字符编码：`/` 与空格、`:`、`\` 等特殊字符替换为 `-`（与 Claude Code 规则一致，便于将来与 CLI 互认）。每个会话一个 `<uuid>.jsonl`，追加写，一行一条 JSON 消息，消息体直接复用现有 `Message` 结构（`JSON.stringify(m)`）。

- **为什么选它而非 workspaceState**：用户可见/可 grep/可备份/可迁移；大 Map 塞 vscdb 的 SQLite KV 性能差。
- **为什么不用 globalStorage**：路径深不可见；用户明确偏好 `.yunForce`，且未来 CLI 伴侣可直接复用同一套文件。
- **为什么不用 SQLite**：为当前规模引入原生依赖（better-sqlite3 编译）不划算；JSONL 追加写已满足。
- 原子性：`append` 采用「单次 `fs.appendFile` 写一行」，单行 ≤ 几千字节，写入中断最多丢一行尾部，不产生半行脏数据；`index.json` 采用「写临时文件 + rename」原子替换。

### D2. 存储抽象：`MessageStore` 内部换后端，接口不变

`MessageStore` 保留现有公开 API（`append`/`loadHistory`/`getCompactionPoint`/`clear`/`deleteMessagesAfter`/`updateMessage`），把「持久化」从 `WorkspaceState` 换成新文件存储实现 `SessionFileStore`。构造改为 `new MessageStore(fileStore)`，`sessionFileStore` 提供 `appendLine`/`readLines`/`rewrite`/`deleteFile` 等原语。`historyLoader`/`agentLoop` 零改动。

- 内存中仍保留 `Map<sessionId, Message[]>` 作为缓存（启动时全量加载到内存，量级为会话数 × 千条，可接受），所有写操作同步更新内存 + 异步落盘（沿用现有 `persist()` 的 fire-and-forget 风格）。
- 1000 条/会话上限与 compaction 检查点逻辑原样保留。

### D3. 会话索引 `index.json`

`~/.yunForce/projects/<ws 编码>/index.json`：

```json
{
  "version": 1,
  "workspacePath": "/Users/.../VSCode-plugin",
  "currentSessionId": "uuid-...",
  "sessions": {
    "<sessionId>": {
      "title": "首条用户消息截断（≤40 字）或自定义名",
      "createdAt": "2026-08-09T08:00:00.000Z",
      "updatedAt": "...",
      "messageCount": 12,
      "customTitle": false
    }
  }
}
```

- `sessions` 有序（按 `updatedAt` 降序展示时在视图层排序）。
- 更新时机：`append` 用户消息且无标题时设标题；每次 `append`/`deleteMessagesAfter` 更新 `updatedAt`/`messageCount`；`createSession`/`setCurrentSessionId` 更新 `currentSessionId`。
- 文件不存在（首次/手动删除）时按空索引重建，不报错。

### D4. 新建会话保留历史

`chatPanel.ts` `createSession` 分支删除 `reset(previousSessionId)` 调用；`LocalSessionManager.createSession()` 内部也改为「创建新 ID + 更新索引 currentSessionId，不触碰旧会话数据」。`reset()` 方法保留（供「清空当前会话」等显式操作，本期 UI 不暴露）。

### D5. resume（继续对话）

复用现有能力：`loadHistory(sessionId)` 已能把历史消息推给前端渲染；`setCurrentSessionId(sessionId)` 已存在。新增 `ChatViewProvider.openSession(sessionId)`：设置 `_currentSessionId` + 通知前端（postMessage `openSession`，前端置 `currentSessionId` 并拉 `loadHistory`）。因 `AgentLoop.run(sessionId, text)` 每轮从 `MessageStore` 加载完整历史（含 compaction），继续会话天然获得完整上下文。

### D6. 历史视图 `HistoryTreeView`

新文件 `src/historyTree.ts`，实现 `vscode.TreeDataProvider<SessionItem>`：
- 根节点：`listSessions()` 返回的会话（按 `updatedAt` 降序），label = 标题，description = 相对时间（如「3 分钟前」）+ 消息数，tooltip = 完整信息 + sessionId 前 8 位
- 空状态：`欢迎开始第一个会话`（vscode 内置空状态文案）
- 命令（`package.json` contributes）：
  - `yunxiaoAgent.history.open`（单击/双击）：`provider.openSession(sessionId)` + 聚焦对话面板
  - `yunxiaoAgent.history.delete`（右键）：确认弹窗后 `sessionManager.deleteSession(sessionId)`，刷新视图
  - `yunxiaoAgent.history.refresh`（视图标题栏刷新按钮）：重读索引刷新
- 数据变更后自动刷新：`MessageStore` 追加消息时经 `EventBus` 发 `session-updated` 事件（若事件类型不合适，则用 `LocalSessionManager` 上挂一个轻量 `onDidChangeSessions` 回调，historyTree 订阅）

### D7. 旧数据迁移

`extension.ts` 装配时：若 `workspaceState.get('yunxiaoAgent.messages')` 存在且新文件存储无数据 → 逐 session 写 JSONL + 建索引 → `workspaceState.update('yunxiaoAgent.messages', undefined)` 清理。迁移失败不阻塞启动（日志告警，继续用新存储）。

### D8. 会话标题

`append` 用户消息时若该 session 尚无标题：取 `content` 去除空白后前 40 字符（换行折叠为空格），写入索引 `title`；`renameSession`（已有前端命令）改为同时写入索引（`customTitle: true`）。

## Risks / Trade-offs

- [JSONL 追加写 + 内存缓存双写不一致] → 所有变更统一走 `persist()` 路径：先改内存再异步落盘；崩溃最多丢最近一次落盘前的增量，可接受（聊天场景）。
- [多窗口同一 workspace 并发写同一 jsonl] → 单行 appendFile 在 Node 中对小写入是原子的；index.json 用临时文件 + rename 原子替换，后者可能丢并发更新 → 接受（索引可重建，`ls *.jsonl` 可恢复列表）。
- [用户手动删/改文件导致损坏] → 读取时逐行 `JSON.parse`，坏行跳过并日志告警；索引缺失自动重建。
- [`.yunForce` 残留] → 用户卸载插件后数据仍在；属有意为之（数据所有权归用户），README/文档说明清理方式。
- [消息体含超大工具结果（受 `toolResultLimit` 约束 ≤10KB）] → 单行可控；若未来放宽需评估分块。

## Migration Plan

1. 实现 `SessionFileStore`（文件原语）+ 改造 `MessageStore`（后端切换 + 索引联动）→ 单测
2. 实现 `LocalSessionManager` 列表/删除/标题接口 → 单测
3. 改造 `chatPanel.ts` createSession 不清空 + 新增 `openSession` → 前端契约
4. 实现 `HistoryTreeView` + `package.json` contributes + `extension.ts` 装配
5. 旧数据迁移逻辑
6. `npm run compile` + `npm test` 全绿
7. 回滚：保留 workspaceState 迁移前快照（迁移为「读取后清理」，若要回滚可先备份 `state.vscdb`）

## Open Questions

- 历史视图与对话面板的联动细节（单击即打开 vs 双击）：按「单击打开」实现，用户可后续调整。
- 是否在历史视图提供「新建会话」快捷入口：本期不加（已有工具栏按钮）。
