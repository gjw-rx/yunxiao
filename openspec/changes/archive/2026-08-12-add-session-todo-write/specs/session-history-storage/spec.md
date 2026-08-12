## ADDED Requirements

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
