## ADDED Requirements

### Requirement: 当前工作区 token 用量按模型聚合
系统 SHALL 从当前工作区的本地持久化会话归档中读取拥有 `tokenUsage` 的 assistant 消息记录，并以记录的 provider 与模型标识组合作为模型维度，累计 `total_tokens`、`prompt_tokens`、`completion_tokens`、`reasoning_tokens` 以及已有的缓存输入明细。缓存明细 SHALL 仅作为输入侧构成展示，MUST NOT 再次计入 `total_tokens`。统计 SHALL 包含已实际落账的模型调用，即使对应消息后来从活动会话路径回滚或删除；同一归档记录 MUST NOT 重复计数。

#### Scenario: 多个模型分别汇总
- **WHEN** 当前工作区归档中模型 A 有两笔 token 账且模型 B 有一笔 token 账
- **THEN** 统计结果分别返回模型 A 与模型 B 的累计值，模型 A 的两笔账相加且不与模型 B 混合

#### Scenario: 回滚后的调用仍计入消耗
- **WHEN** 一笔已持久化 token 账所属消息后来被回滚出活动会话路径
- **THEN** 用量统计仍计入该笔已发生的模型调用，且只计一次

#### Scenario: 缓存明细不重复增加总量
- **WHEN** 一笔 token 账同时包含 `total_tokens=150` 与 `cache_read_tokens=80`
- **THEN** 模型累计总量增加 150，缓存读取明细增加 80，累计总量不会增加到 230

### Requirement: token 用量按自然日周月分桶
系统 SHALL 使用 token 账对应归档 entry 的记录时间，以 VS Code 扩展宿主所在系统的本地时区划分自然日、自然周和自然月。自然周 SHALL 从周一 00:00:00 开始并在下周一前结束；自然月 SHALL 从当月第一天 00:00:00 开始并在下月第一天前结束。请求结果 SHALL 返回粒度、时间段起止、区间总量和区间内的模型明细，边界采用左闭右开区间以避免跨桶重复计数。

#### Scenario: 按天统计当前自然日
- **WHEN** 用户请求某个自然日，账目时间分别位于该日 00:00、该日 23:59 与次日 00:00
- **THEN** 前两笔进入该日统计，次日 00:00 的账进入下一自然日

#### Scenario: 按周统计从周一开始
- **WHEN** 用户请求包含周一至周日的自然周
- **THEN** 周一 00:00 至下周一 00:00 前的账被纳入，前一周周日与下一周周一的账不被纳入

#### Scenario: 按月统计跨月边界
- **WHEN** 用户请求八月且账目分别发生在八月最后一刻与九月第一刻
- **THEN** 八月统计只包含八月最后一刻的账

### Requirement: 历史兼容与诊断状态
统计器 SHALL 兼容旧归档：有合法 token 账但缺少模型标识的记录 MUST 归入稳定的“未知模型”分组，不得按当前默认模型猜测；缺少 token 账的消息 SHALL NOT 为跨会话用量统计生成估算值。单个损坏或无法解析的会话归档 SHALL 被跳过并通过统一 logger 记录含文件或会话标识的中文诊断，同时返回其余可用统计以及数据不完整标记；只有统计请求整体无法完成时才返回有界错误。

#### Scenario: 旧 token 账缺少模型标识
- **WHEN** 旧 assistant 记录具有合法 tokenUsage 但没有 provider 或模型字段
- **THEN** 该笔账进入“未知模型”分组，不进入当前默认模型分组

#### Scenario: 旧消息没有 token 账
- **WHEN** 历史消息只有正文而没有 tokenUsage
- **THEN** 跨会话统计忽略该消息，不根据正文估算 token

#### Scenario: 单个归档损坏
- **WHEN** 扫描多个会话时其中一个归档无法解析而其他归档有效
- **THEN** 系统记录诊断日志，返回有效归档的统计并标记结果可能不完整

