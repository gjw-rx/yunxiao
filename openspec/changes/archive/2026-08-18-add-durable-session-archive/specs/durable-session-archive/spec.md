## ADDED Requirements

### Requirement: 版本化追加式会话归档记录

系统 SHALL 将每个非空会话持久化为版本化的 SessionRecord JSONL 文件。第一条有效记录 MUST 是包含会话 ID、版本、创建时间和 workspace 信息的 session header；后续可恢复节点 MUST 具有唯一 `id`、`parentId`、单调递增的 `recordSeq` 和时间戳。正常的用户消息、assistant 最终消息、工具结果、压缩检查点和活动位置更新 SHALL 以追加记录写入，且系统 MUST NOT 因消息数量上限删除原始归档记录。

#### Scenario: 首条用户消息建立可恢复归档
- **WHEN** 新会话首次接受一条用户消息
- **THEN** 系统 SHALL 写入 session header 和该消息对应的 Entry，且该 Entry 的 `parentId` 为 `null`

#### Scenario: 后续记录保持追加顺序
- **WHEN** 已归档会话产生 assistant 最终消息和工具结果
- **THEN** 系统 SHALL 追加具有更大 `recordSeq` 的新记录，且 MUST NOT 修改此前正常追加的记录

#### Scenario: 历史超过旧消息上限
- **WHEN** 会话原始记录数量超过此前的 1000 条限制
- **THEN** 系统 SHALL 保留全部原始归档记录，并仅由 UI 或上下文投影限制展示或发送数量

### Requirement: 活动路径与完整归档分离

系统 SHALL 从完整归档构建独立的活动路径和 LLM 上下文投影。活动位置 MUST 通过可恢复记录持久化；活动路径 SHALL 从该位置沿 `parentId` 回溯并按根到 leaf 顺序返回。完整归档查询 MUST 保留不在活动路径上的合法 Entry，且 LLM 上下文 MUST NOT 混入相邻或已离开的路径。

#### Scenario: 活动位置跨重启恢复
- **WHEN** 会话已持久化活动位置后关闭并重新打开扩展
- **THEN** 系统 SHALL 恢复相同的活动 Entry，并从该 Entry 构建活动路径

#### Scenario: 非活动记录不进入上下文
- **WHEN** 完整归档包含不属于当前活动路径的合法 Entry
- **THEN** `HistoryLoader` SHALL 不将该 Entry 投影为后续 LLM 请求消息

### Requirement: 归档提交可确认且失败可见

存储层 SHALL 为排队会话写入提供可等待的提交结果。AgentLoop MUST 在开始模型调用前确认本次用户消息已提交，并在发布 completed、cancelled 或 failed 的运行终态前确认本次已经形成的 assistant 最终消息和工具结果已提交。写入失败 MUST 使对应运行进入可见失败状态并记录包含 sessionId、recordSeq 与错误原因的日志；系统 MUST NOT 仅记录日志后把失败视为已归档。

#### Scenario: 用户消息提交后才调用模型
- **WHEN** AgentLoop 接受用户输入
- **THEN** 系统 SHALL 在用户消息归档提交成功后才开始该次模型调用

#### Scenario: 最终回复提交后才结束运行
- **WHEN** AgentLoop 获得无需继续调用工具的 assistant 最终消息
- **THEN** 系统 SHALL 在该消息提交成功后才发布 completed 和 stream_end

#### Scenario: 归档提交失败
- **WHEN** 任一必须确认的会话写入失败
- **THEN** 系统 SHALL 发布失败状态且 MUST NOT 发布该运行的 completed 状态

#### Scenario: 扩展停用时存在待提交写入
- **WHEN** 扩展开始 deactivate 且存在待提交的会话记录
- **THEN** 系统 SHALL 等待这些提交结算后才完成 deactivate

### Requirement: 索引可重建且旧归档安全迁移

会话索引 SHALL 是从合法归档记录导出的缓存，不得作为会话存在性的唯一依据。索引缺失或损坏时，系统 SHALL 扫描当前 workspace 的合法 session header 重建索引和活动位置。系统 SHALL 支持读取旧的裸 Message JSONL，并在迁移为版本化归档时先写入临时文件、验证 header、ID 唯一性、父引用和记录顺序，再原子替换目标文件；迁移失败 MUST 保留原文件且不得阻止旧会话只读加载。

#### Scenario: 索引丢失后恢复会话列表
- **WHEN** 合法会话 JSONL 存在但 `index.json` 缺失或无法解析
- **THEN** 系统 SHALL 从归档重建索引，并在会话列表中返回该会话

#### Scenario: 旧线性 JSONL 成功迁移
- **WHEN** 系统首次写入或打开一个由裸 Message 行组成的旧会话文件
- **THEN** 系统 SHALL 将原顺序映射为线性父子 Entry、写入版本化 header，并保留可恢复的原文件备份

#### Scenario: 迁移校验失败
- **WHEN** 旧会话迁移生成的临时归档未通过结构校验
- **THEN** 系统 SHALL 删除临时迁移产物、保留原文件，并以诊断日志报告失败原因

### Requirement: 损坏归档不得静默形成不合法上下文

系统 MUST 校验会话 header、Entry ID 唯一性、父引用无环、活动位置和压缩边界引用。遇到无法解析或不合法的记录时，系统 SHALL 记录可定位诊断并只使用已验证的连续记录恢复；系统 MUST NOT 自动重写未知损坏的源归档，也 MUST NOT 向 LLM 提供包含孤立工具结果或缺失父链的上下文。

#### Scenario: 压缩边界指向不存在 Entry
- **WHEN** 活动路径上的 compaction Entry 的保留边界不存在或不在该路径
- **THEN** 系统 SHALL 将该会话标记为归档损坏并拒绝使用该不完整上下文发起 LLM 请求

