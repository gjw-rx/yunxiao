# Proposal: session-history-and-storage

## Why

当前「新建会话」是**销毁式**的：`chatPanel.ts` 的 `createSession` 会 `reset()` 上一个会话并将其消息从 `MessageStore` 中 `clear()` 掉，会话历史随切换即丢失。同时消息持久化依赖 VSCode `workspaceState`（藏在 `state.vscdb` 里），用户不可见、不可备份、不可迁移，且缺少会话列表入口，历史会话无处发现与回放。

需要把会话从「一次性临时对象」升级为「可长期保留、可查看、可续聊的一等公民」，参照 Claude Code 的存储范式（`~/.claude/projects/<workspace 编码>/<session>.jsonl`）。

## What Changes

- **新建会话不再清空旧会话**（BREAKING 行为变更）：`createSession` 只创建新 ID 并切换指针，旧会话及其消息完整保留在存储中。
- **新增文件存储后端**：消息持久化从 `workspaceState` 迁移到 `~/.yunForce/projects/<workspace 路径编码>/<sessionId>.jsonl`，每行一条 JSON 消息（追加写），保持 `MessageStore` 对外接口不变，`agentLoop` / `historyLoader` 无感。
- **新增会话索引**：`~/.yunForce/projects/<workspace 编码>/index.json` 维护会话元数据（标题、创建/更新时间、消息数、当前活跃会话），供历史列表展示；标题默认取首条用户消息截断，`renameSession` 的自定义名称也持久化到此。
- **新增历史会话视图**：activity bar 新增「历史」TreeView，列出当前 workspace 的会话（标题 + 相对时间 + 消息数），支持回放、继续对话（resume）、删除会话。
- **旧数据一次性迁移**：首次激活时若 `workspaceState` 中存在旧 `yunxiaoAgent.messages`，迁移到新文件存储后清理。
- **作用域**：会话按 workspace 隔离（目录名编码 workspace 路径），多 workspace 互不干扰。

## Capabilities

### New Capabilities
- `session-history-storage`: 会话消息的文件持久化（JSONL 追加写）、会话索引维护、workspace 隔离、历史保留（新建不清空）、旧数据迁移
- `session-history-view`: 侧边栏历史会话列表（TreeView）、回放、继续对话（resume）、删除会话

### Modified Capabilities
- `local-agent-session`: 新增会话列表/删除/标题维护接口（`listSessions`、`deleteSession`、默认标题）——ADDED requirements，不改动既有行为；「新建会话保留旧会话」作为新需求归属 `session-history-storage`

## Impact

- `src/memory/messageStore.ts`：持久化后端从 workspaceState 切换为文件存储（接口不变）
- `src/core/localSessionManager.ts`：新增 `listSessions` / `deleteSession` / 会话标题维护
- `src/chatPanel.ts`：`createSession` 不再 reset 旧会话；暴露供历史视图调用「打开会话」的方法
- 新增 `src/historyTree.ts`（TreeDataProvider + 命令注册）
- `src/extension.ts`：装配文件存储、历史视图，注册命令与视图
- `package.json`：新增 view container「历史」视图、`history.*` 命令、`media/icon-history.svg` 图标
- 测试：`src/test/memory/` 新增文件存储与索引的单元测试；`localSessionManager` 列表/删除测试
- 不引入新依赖（JSONL 用 `fs` 原生读写；workspace 编码复用 Node `path`/字符串替换）
