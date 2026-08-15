## ADDED Requirements

### Requirement: 转换命令保留原始终端安全与审批语义
当受信任 Hook 将 `terminal_exec.command` 转换为最终命令时，终端工具 SHALL 获得原始命令、最终命令和可信转换来源。系统 SHALL 对原始和最终命令均执行危险命令检查；白名单与删除意图 SHALL 基于原始命令判断，以保留用户原有的自动允许和 destructive 审批语义；实际 Shell SHALL 执行最终命令。需要审批时，审批内容 SHALL 同时展示原始命令、最终命令和转换来源。

#### Scenario: 白名单命令经 RTK 改写后仍自动允许
- **WHEN** 原始命令 `npm test` 匹配终端白名单，且 RTK 将其改写为等价 RTK 命令
- **THEN** 系统不因新增的 RTK 前缀把该调用改判为 unknown，且执行改写后的命令

#### Scenario: 改写后命令触发危险检查
- **WHEN** 最终命令匹配现有危险命令规则
- **THEN** 系统取消调用且不显示允许审批，不执行最终命令

#### Scenario: 未知命令审批显示转换信息
- **WHEN** 原始命令需要审批且受信任 Hook 返回了最终命令
- **THEN** 用户在审批卡片中可以看到原始命令、改写后命令和 Hook 来源，并且拒绝时两个命令均不执行
