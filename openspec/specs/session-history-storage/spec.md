# session-history-storage Specification

## Purpose

定义 VS Code 插件会话消息、会话索引和任务快照在本地文件中的持久化、恢复、工作区隔离、兼容迁移与删除清理行为。
## Requirements
### Requirement: 会话消息持久化到用户目录 JSONL 文件
会话可恢复记录 SHALL 持久化到 `~/.yunForce/projects/<workspace 路径编码>/<sessionId>.jsonl` 文件中。文件 SHALL 使用版本化 SessionRecord JSONL：第一条有效记录为 session header，后续消息、压缩检查点和活动位置使用可恢复记录；正常新增记录 SHALL 追加写。`MessageStore` SHALL 保留面向既有调用方的消息读取与追加门面，并返回活动路径的消息投影；完整归档由专用读取接口提供。原始归档 MUST NOT 因固定消息条数上限而被删除。文件不存在时读取 SHALL 返回空列表而不报错；无法解析或不合法的记录 SHALL 产生诊断日志，且系统 MUST NOT 用迁移或恢复流程覆盖未知损坏源文件。

#### Scenario: 追加消息写入归档记录
- **WHEN** 向会话 `s1` 追加一条用户消息
- **THEN** 系统 SHALL 在 `~/.yunForce/projects/<ws 编码>/s1.jsonl` 中写入 header 后追加该消息对应的 Entry，且活动历史投影包含该消息

#### Scenario: 文件不存在时读取为空
- **WHEN** 调用活动历史读取且对应 JSONL 文件不存在
- **THEN** 系统 SHALL 返回空数组，不抛异常

#### Scenario: 损坏记录保留原件并报告诊断
- **WHEN** JSONL 文件中存在无法解析或不符合归档结构的记录
- **THEN** 系统 SHALL 记录包含 sessionId 和记录位置的诊断，保留源文件，并且不将该记录投入 LLM 上下文

#### Scenario: 历史超过展示上限
- **WHEN** 会话的原始归档记录超过 UI 或旧消息缓存上限
- **THEN** 系统 SHALL 保留完整 JSONL 原始记录，并仅在相应投影层限制返回数量

### Requirement: 会话按 workspace 隔离存储
会话文件 SHALL 按 workspace 根路径隔离存储：workspace 根绝对路径经字符编码（`/`、空格、`:`、`\` 等替换为 `-`，与 Claude Code 规则一致）后作为 `~/.yunForce/projects/` 下的目录名，不同 workspace 的会话互不可见。

#### Scenario: 不同 workspace 目录隔离
- **WHEN** workspace A 与 workspace B 各创建会话
- **THEN** 会话文件分别落在 `projects/<A 编码>/` 与 `projects/<B 编码>/` 两个目录，`listSessions` 只返回当前 workspace 的会话

### Requirement: 会话索引维护
系统 SHALL 维护 `~/.yunForce/projects/<ws 编码>/index.json` 作为会话列表、标题、时间、活动位置和消息计数的可重建缓存。消息追加、永久删除、会话创建/切换 SHALL 更新索引；索引写入 SHALL 采用临时文件后 rename 的原子替换。索引缺失、损坏或包含不存在会话时，系统 SHALL 从当前 workspace 的合法归档 header 与记录重建索引，而不得把索引内容作为会话是否存在的唯一来源。

#### Scenario: 首次追加用户消息生成标题
- **WHEN** 会话 `s1` 尚无标题时追加一条用户消息「帮我修复登录 bug\n详情见附件」
- **THEN** 索引中 `s1.title` SHALL 为「帮我修复登录 bug 详情见附件」的截断版本，且消息计数反映已提交的消息记录

#### Scenario: 索引缺失自动重建
- **WHEN** 合法会话归档仍存在但索引文件被删除后调用 `listSessions`
- **THEN** 系统 SHALL 重建索引、返回该会话且不抛异常

#### Scenario: 自定义标题优先
- **WHEN** 用户通过 `renameSession` 为会话设置自定义名称
- **THEN** 索引中该会话标题 SHALL 使用自定义名称，不再被首条用户消息截断覆盖

### Requirement: 新建会话保留旧会话
创建新会话 SHALL NOT 删除或清空任何既有会话的消息数据，仅创建新会话 ID 并更新索引的 `currentSessionId`。旧会话 SHALL 保持可通过 `listSessions` 列出、`loadHistory` 回放、`setCurrentSessionId` 恢复。

#### Scenario: 新建会话后旧会话仍在
- **WHEN** 会话 `s1` 有 5 条消息，用户新建会话 `s2`
- **THEN** `s1` 的 JSONL 文件与索引条目均保留，`listSessions` 同时返回 `s1` 与 `s2`

### Requirement: 旧 workspaceState 数据与旧 JSONL 的安全迁移
首次激活时，若 `workspaceState` 中存在旧 `yunxiaoAgent.messages` 数据且新文件存储为空，系统 SHALL 将旧数据逐会话迁移为版本化 JSONL 归档并建立索引，随后清理旧 workspaceState 键。对于已存在的旧裸 Message JSONL，系统 SHALL 在迁移成功前保持原文件可读取，并使用临时文件、结构校验、原子替换和可恢复备份完成转换。任一迁移失败 SHALL NOT 阻塞插件启动，SHALL 记录日志告警且不得覆盖原始数据。

#### Scenario: workspaceState 迁移成功
- **WHEN** 升级后首次激活且存在旧 workspaceState 消息数据
- **THEN** 旧会话 SHALL 以版本化归档出现在 `listSessions` 与历史视图中，workspaceState 旧键被清理

#### Scenario: 旧 JSONL 迁移成功
- **WHEN** 系统打开一个旧格式的会话 JSONL
- **THEN** 系统 SHALL 在校验成功后建立版本化归档与备份，并保持相同的线性历史投影

#### Scenario: 迁移失败不阻塞启动
- **WHEN** 迁移过程中写入或校验失败
- **THEN** 插件 SHALL 正常启动，输出日志告警，原始会话文件保持不变且新会话照常工作

### Requirement: 会话索引持久化任务快照
系统 SHALL 在 workspace 会话 `index.json` 中按 `sessionId` 保存最新的任务快照。任务快照 SHALL 与会话索引使用相同的串行写入和原子替换机制；缺少、损坏或不符合任务快照结构的索引数据 MUST 被视为空任务状态，且 MUST NOT 阻止会话历史加载。

#### Scenario: 任务快照原子持久化
- **WHEN** 当前会话成功写入新的任务列表
- **THEN** 系统以原子索引更新持久化该会话快照，重启后可读取相同内容

#### Scenario: 旧索引兼容
- **WHEN** 读取不含任务快照字段的既有 `index.json`
- **THEN** 系统将该会话视为无任务列表并正常加载其消息与元数据

### Requirement: 删除会话同时删除任务快照
系统 SHALL 在删除会话时一并移除该会话的任务快照。删除一个会话 MUST NOT 移除同一 workspace 中其他会话的任务快照。

#### Scenario: 删除会话清理任务记录
- **WHEN** 用户确认删除拥有任务快照的会话 `s1`
- **THEN** `s1` 的 JSONL、会话索引条目和任务快照均被移除，且其他会话的任务快照保持不变

### Requirement: 单条消息删除与 turn 截断的持久化
`MessageStore` SHALL 新增 `deleteMessage(sessionId, seq)` 接口，按被删消息角色补删配对消息（用户消息级联整个 turn、带 `toolCalls` 的助手消息级联其工具结果、工具结果同步清理孤立 `toolCalls`）。删除操作 SHALL 通过 JSONL 整体重写持久化，并 SHALL 同步更新会话索引的 `messageCount` 与 `updatedAt`。既有的 `append`/`loadHistory`/`getCompactionPoint`/`clear`/`deleteMessagesAfter`/`updateMessage` 接口签名 SHALL 保持不变。

#### Scenario: 删除后 JSONL 与索引一致
- **WHEN** 会话 `s1` 有 6 条消息，删除 seq=3 的用户消息（级联删除 seq 3 至 5）
- **THEN** `s1.jsonl` 只保留 seq 0 至 2 的消息，索引中 `s1.messageCount` 更新为 3，`updatedAt` 刷新

#### Scenario: 删除不存在的 seq 为无操作
- **WHEN** 对不存在的 seq 调用 `deleteMessage`
- **THEN** 消息与索引均不变，不抛异常

