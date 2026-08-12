## REMOVED Requirements

### Requirement: HistoryLoader SHALL trigger compaction by message count and token count
**Reason**: 消息数量和物理历史 token 未包含系统提示词、工具 schema 与模型输出预留，不能代表实际请求压力。
**Migration**: 改用 `context-compaction` 能力定义的完整请求预算与模型上下文比例触发。
