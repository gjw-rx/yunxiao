## MODIFIED Requirements

### Requirement: 压缩检查点 SHALL 增量汇总活动路径的有效历史

系统 SHALL 从活动路径上的最新压缩检查点恢复有效历史，将已有摘要和待压缩前段交给摘要模型；只有摘要成功时才能追加新的压缩检查点。检查点 SHALL 保存摘要、保留原文的 `firstKeptEntryId` 边界和可选任务上下文，而 MUST NOT 复制近期消息副本。完整归档中的原始消息 SHALL 不因压缩被物理删除；构建 LLM 上下文时，系统 SHALL 使用摘要、边界起到 checkpoint 前的有效路径原文，以及 checkpoint 后的有效路径记录。

#### Scenario: 二次压缩

- **WHEN** 活动路径上已存在一个压缩检查点且有效上下文再次达到阈值
- **THEN** 新摘要 SHALL 包含已有摘要和本次被压缩前段的信息，并成为活动路径上唯一生效的最新检查点

#### Scenario: 摘要失败

- **WHEN** 摘要模型调用失败或返回空摘要
- **THEN** 系统 SHALL 不追加检查点且 SHALL 保留原有效历史

#### Scenario: 检查点不复制近期消息

- **WHEN** 系统成功创建压缩检查点
- **THEN** 归档中的检查点 SHALL 仅引用 `firstKeptEntryId`，近期原文仍由原始消息 Entry 提供

### Requirement: 压缩后的工具调用关系必须完整

系统 SHALL 将 assistant 的工具调用及其全部对应 tool 结果作为不可分割的活动路径单元。系统 SHALL 在选择 `firstKeptEntryId` 时扩大或收缩保留边界，以避免保留孤立 tool 结果或缺失结果的 assistant 工具调用；保留的非工具消息顺序 SHALL 不变。系统 MUST NOT 修改原始消息 Entry 来修复工具配对；若合法边界无法构建，系统 SHALL 拒绝生成该检查点并记录清理日志。

#### Scenario: 尾部边界命中工具结果

- **WHEN** 尾部 token 预算刚好从一个 tool 结果开始
- **THEN** 系统 SHALL 将 `firstKeptEntryId` 调整到对应 assistant 工具调用，并保留同一调用的其余 tool 结果

#### Scenario: 孤立工具消息

- **WHEN** 活动路径中某 tool 消息的 `toolCallId` 不存在于任何有效 assistant `toolCalls`
- **THEN** 系统 SHALL 拒绝将该不完整单元纳入压缩后的 LLM 上下文并记录清理日志

#### Scenario: 缺失工具结果

- **WHEN** 活动路径中的 assistant 消息包含一个或多个没有对应 tool 结果的 `toolCalls`
- **THEN** 系统 SHALL 调整保留边界或拒绝创建检查点，且 MUST NOT 写入会导致不完整工具关系的上下文

