# session-history-storage Specification

## ADDED Requirements

### Requirement: 会话消息持久化到用户目录 JSONL 文件
会话消息 SHALL 持久化到 `~/.yunForce/projects/<workspace 路径编码>/<sessionId>.jsonl` 文件中，每个会话一个文件，JSONL 格式（每行一条 JSON 消息，消息体复用存储层 `Message` 结构），追加写。`MessageStore` 对外接口（`append`/`loadHistory`/`getCompactionPoint`/`clear`/`deleteMessagesAfter`/`updateMessage`）SHALL 保持不变，`AgentLoop` 与 `HistoryLoader` 无需感知存储介质变化。文件不存在时读取 SHALL 返回空列表而不报错；坏行 SHALL 跳过并记录日志。

#### Scenario: 追加消息写入 JSONL
- **WHEN** 向会话 `s1` 追加一条用户消息
- **THEN** 该消息以一行 JSON 追加到 `~/.yunForce/projects/<ws 编码>/s1.jsonl` 末尾，且 `loadHistory('s1')` 返回包含该消息的完整列表

#### Scenario: 文件不存在时读取为空
- **WHEN** 调用 `loadHistory` 且对应 JSONL 文件不存在
- **THEN** 返回空数组，不抛异常

#### Scenario: 坏行跳过
- **WHEN** JSONL 文件中某一行不是合法 JSON
- **THEN** 该行被跳过，其余行正常解析，并输出日志告警

### Requirement: 会话按 workspace 隔离存储
会话文件 SHALL 按 workspace 根路径隔离存储：workspace 根绝对路径经字符编码（`/`、空格、`:`、`\` 等替换为 `-`，与 Claude Code 规则一致）后作为 `~/.yunForce/projects/` 下的目录名，不同 workspace 的会话互不可见。

#### Scenario: 不同 workspace 目录隔离
- **WHEN** workspace A 与 workspace B 各创建会话
- **THEN** 会话文件分别落在 `projects/<A 编码>/` 与 `projects/<B 编码>/` 两个目录，`listSessions` 只返回当前 workspace 的会话

### Requirement: 会话索引维护
系统 SHALL 维护 `~/.yunForce/projects/<ws 编码>/index.json` 会话索引，记录每个会话的 `title`（首条用户消息截断 ≤40 字，或用户自定义名）、`createdAt`、`updatedAt`、`messageCount`，以及当前活跃会话 `currentSessionId`。消息追加、删除、会话创建/切换 SHALL 同步更新索引；索引缺失 SHALL 自动重建为空索引而不报错。索引写入 SHALL 采用原子替换（写临时文件后 rename），避免写坏。

#### Scenario: 首次追加用户消息生成标题
- **WHEN** 会话 `s1` 尚无标题时追加一条用户消息「帮我修复登录 bug\n详情见附件」
- **THEN** 索引中 `s1.title` 为「帮我修复登录 bug 详情见附件」的截断版本，`messageCount` 为 1

#### Scenario: 索引缺失自动重建
- **WHEN** 索引文件被删除后调用 `listSessions`
- **THEN** 返回空列表且不抛异常，后续写入重新创建索引

#### Scenario: 自定义标题优先
- **WHEN** 用户通过 `renameSession` 为会话设置自定义名称
- **THEN** 索引中该会话标题使用自定义名称，不再被首条消息截断覆盖

### Requirement: 新建会话保留旧会话
创建新会话 SHALL NOT 删除或清空任何既有会话的消息数据，仅创建新会话 ID 并更新索引的 `currentSessionId`。旧会话 SHALL 保持可通过 `listSessions` 列出、`loadHistory` 回放、`setCurrentSessionId` 恢复。

#### Scenario: 新建会话后旧会话仍在
- **WHEN** 会话 `s1` 有 5 条消息，用户新建会话 `s2`
- **THEN** `s1` 的 JSONL 文件与索引条目均保留，`listSessions` 同时返回 `s1` 与 `s2`

### Requirement: 旧 workspaceState 数据迁移
首次激活时，若 `workspaceState` 中存在旧 `yunxiaoAgent.messages` 数据且新文件存储为空，系统 SHALL 将旧数据逐会话迁移为 JSONL 文件并建立索引，随后清理旧 workspaceState 键。迁移失败 SHALL NOT 阻塞插件启动，SHALL 记录日志告警。

#### Scenario: 迁移成功
- **WHEN** 升级后首次激活且存在旧 workspaceState 消息数据
- **THEN** 旧会话出现在 `listSessions` 与历史视图中，workspaceState 旧键被清理

#### Scenario: 迁移失败不阻塞启动
- **WHEN** 迁移过程中写入文件失败
- **THEN** 插件正常启动，输出日志告警，新会话照常工作
