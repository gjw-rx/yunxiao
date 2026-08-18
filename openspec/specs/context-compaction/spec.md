## Purpose

在 LLM 请求接近模型上下文窗口时，以完整请求 token 预算触发可观测的增量上下文压缩，并保持工具调用关系完整。
## Requirements
### Requirement: 完整请求预算触发自动压缩

系统 SHALL 在每次 LLM 请求前复用既有 token 估算机制，计入系统提示词、有效历史消息和当前可用工具 schema。自动压缩 SHALL 在完整请求估算值达到 `(模型最大上下文 token - 当前最大输出 token) × 自动触发比例` 时执行；默认最大上下文为 `262144`，默认比例为 `75`。

#### Scenario: 工具 schema 使请求达到阈值

- **WHEN** 历史消息本身低于阈值，但加上系统提示词和工具 schema 后完整请求估算值达到阈值
- **THEN** 系统 SHALL 在调用 LLM 前执行自动压缩

#### Scenario: 请求低于阈值

- **WHEN** 完整请求估算值低于当前阈值
- **THEN** 系统 SHALL 不执行自动压缩

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

### Requirement: 手动压缩命令

系统 SHALL 提供 `/compact`。从命令菜单选择或精确输入该文本时，宿主 SHALL 直接请求压缩而不把该文本写入会话历史或发送给 LLM。手动压缩 SHALL 忽略自动压缩开关、触发阈值及自动阈值导出的尾部预算，并 SHALL 按当前有效历史的尾部保留比例选择近期原文；正在运行的会话 SHALL 拒绝手动压缩。

#### Scenario: 空闲会话手动压缩

- **WHEN** 用户在空闲会话输入 `/compact`
- **THEN** 系统 SHALL 执行一次压缩并向用户展示结果

#### Scenario: 有效历史低于自动尾部预算

- **WHEN** 会话有多条有效历史但其 token 数低于自动压缩的尾部原文预算
- **THEN** 用户触发 `/compact` 时系统 SHALL 仍生成新的压缩检查点

#### Scenario: 运行中的会话手动压缩

- **WHEN** 用户在 AgentLoop 运行期间触发 `/compact`
- **THEN** 系统 SHALL 拒绝该请求且 SHALL 不改写会话历史

### Requirement: 压缩可观测性

系统 SHALL 在压缩入口、自动判定、摘要开始、工具配对清理、成功、跳过和失败时写入统一日志。日志 SHALL 包含 sessionId、触发原因、请求 token、阈值、消息数量和清理数量中的适用字段。

#### Scenario: 自动压缩完成

- **WHEN** 自动压缩成功追加检查点
- **THEN** Output Channel SHALL 包含带 sessionId、触发原因、压缩前后消息数量和 token 信息的成功日志

### Requirement: 压缩检查点保留确定性的活跃任务上下文

系统 SHALL 在成功写入上下文压缩检查点时，将当时持久化任务快照中的 `pending` 和 `in_progress` 项作为确定性的可选检查点任务上下文一并保存。有效历史重建时，系统 SHALL 将该上下文与压缩摘要一同提供给模型；该上下文 SHALL 保持不变，直到下一次成功压缩替换检查点。缺失、损坏或不含任务上下文的旧检查点 MUST 被视为不含任务上下文，且 MUST NOT 阻止历史加载。

#### Scenario: 成功压缩保留活跃任务

- **WHEN** 会话在存在活跃任务时成功生成并写入压缩检查点
- **THEN** 随后的有效历史 SHALL 包含该检查点的活跃任务上下文

#### Scenario: 压缩后更新任务

- **WHEN** 检查点已包含活跃任务上下文，随后模型成功调用 `todo_write` 更新任务状态
- **THEN** 下一次模型请求 SHALL 保留不变的检查点上下文，并通过较新的工具结果获得更新后的任务状态

#### Scenario: 兼容旧检查点

- **WHEN** 系统读取不含检查点任务上下文的既有压缩记录
- **THEN** 系统 SHALL 正常重建其摘要和近期历史，并由会话任务恢复机制决定是否需要临时上下文

