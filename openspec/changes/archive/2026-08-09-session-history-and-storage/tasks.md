# Tasks: session-history-and-storage

## 1. 存储层：文件存储与索引

- [x] 1.1 新建 `src/memory/sessionFileStore.ts`：workspace 路径编码、JSONL 追加写/读取（坏行跳过）、index.json 原子读写
- [x] 1.2 改造 `src/memory/messageStore.ts`：持久化后端从 `WorkspaceState` 切换为 `SessionFileStore`，保留公开接口与 1000 条上限/compaction 逻辑，落盘时联动更新索引（标题/updatedAt/messageCount/currentSessionId）
- [x] 1.3 单元测试：文件存储读写/坏行/原子写，索引更新/缺失重建

## 2. 会话管理接口

- [x] 2.1 `LocalSessionManager` 新增 `listSessions()`（按 updatedAt 降序）、`deleteSession(sessionId)`（取消 AgentLoop + 删文件 + 删索引）、默认标题生成
- [x] 2.2 `createSession()` 不再触碰旧会话数据，仅创建新 ID + 更新索引 currentSessionId
- [x] 2.3 单元测试：列表排序、删除、新建保留旧会话

## 3. 对话面板行为变更

- [x] 3.1 `chatPanel.ts` `createSession` 分支移除 `reset(previousSessionId)`；`renameSession` 持久化到索引
- [x] 3.2 `ChatViewProvider` 新增 `openSession(sessionId)`：设置 `_currentSessionId` + postMessage `openSession`（前端置 `currentSessionId` 并拉 `loadHistory`）

## 4. 历史视图（TreeView）

- [x] 4.1 新建 `src/historyTree.ts`：`TreeDataProvider` 展示会话列表（标题/相对时间/消息数/空状态），订阅会话变更自动刷新
- [x] 4.2 `package.json`：新增「历史」view container 视图、`yunxiaoAgent.history.open/delete/refresh` 命令、`media/icon-history.svg` 图标
- [x] 4.3 `extension.ts` 装配：创建 `SessionFileStore` + `MessageStore` 新构造、注册 `HistoryTreeView` 与命令、旧 workspaceState 数据迁移

## 5. 验证

- [x] 5.1 `npm run compile` 通过（类型检查 + lint + esbuild）
- [x] 5.2 `npm test` 全绿
