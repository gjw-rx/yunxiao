## ADDED Requirements

### Requirement: 完整请求预算触发自动压缩
系统 SHALL 在每次 LLM 请求前复用既有 token 估算机制，计入系统提示词、有效历史消息和当前可用工具 schema。自动压缩 SHALL 在该完整请求估算值达到 `(模型最大上下文 token - 当前最大输出 token) × 自动触发比例` 时执行；默认最大上下文为 `262144`，默认比例为 `75`。

#### Scenario: 工具 schema 使请求达到阈值
- **WHEN** 历史消息本身低于阈值，但加上系统提示词和工具 schema 后完整请求估算值达到阈值
- **THEN** 系统 SHALL 在调用 LLM 前执行自动压缩

#### Scenario: 请求低于阈值
- **WHEN** 完整请求估算值低于当前阈值
- **THEN** 系统 SHALL 不执行自动压缩

### Requirement: 压缩检查点 SHALL 增量汇总有效历史
系统 SHALL 从最新压缩检查点恢复有效历史，将已有摘要和待压缩前段交给摘要模型；只有摘要成功时才能追加新的压缩检查点。检查点 SHALL 保留经过工具配对校验的近期上下文，历史 UI 中的原始消息 SHALL 不被物理删除。

#### Scenario: 二次压缩
- **WHEN** 已存在一个压缩检查点且有效上下文再次达到阈值
- **THEN** 新摘要 SHALL 包含已有摘要和本次被压缩前段的信息，并成为唯一生效的最新检查点

#### Scenario: 摘要失败
- **WHEN** 摘要模型调用失败或返回空摘要
- **THEN** 系统 SHALL 不追加检查点且 SHALL 保留原有效历史

### Requirement: 压缩后的工具调用关系必须完整
系统 SHALL 将 assistant 的工具调用及其全部对应 tool 结果作为不可分割的尾部单元。系统 SHALL 在写入检查点前删除没有对应 assistant 调用的 tool 结果，以及没有全部对应结果的 assistant 工具调用；保留的非工具消息顺序 SHALL 不变。

#### Scenario: 尾部边界命中工具结果
- **WHEN** 尾部 token 预算刚好从一个 tool 结果开始
- **THEN** 系统 SHALL 同时保留其 assistant 工具调用和同一调用的其他 tool 结果

#### Scenario: 孤立工具消息
- **WHEN** 有 tool 消息的 `toolCallId` 不存在于任一保留的 assistant `toolCalls`
- **THEN** 系统 SHALL 从检查点近期上下文移除该 tool 消息并记录清理日志

#### Scenario: 缺失工具结果
- **WHEN** assistant 消息中的一个或多个 `toolCalls` 没有对应 tool 结果
- **THEN** 系统 SHALL 从检查点近期上下文移除该 assistant 工具调用并记录清理日志

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
系统 SHALL 在压缩入口、自动判定、摘要开始、工具对清理、成功、跳过和失败时写入统一日志。日志 SHALL 包含 sessionId、触发原因、请求 token、阈值、消息数量和清理数量中的适用字段。

#### Scenario: 自动压缩完成
- **WHEN** 自动压缩成功追加检查点
- **THEN** Output Channel SHALL 包含带 sessionId、触发原因、压缩前后消息数量和 token 信息的成功日志
