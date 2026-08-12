## ADDED Requirements

### Requirement: 基础功能菜单提供 /compact
系统 SHALL 在基础功能命令表中提供命令词 `compact`、动作 `compactContext`、展示名“压缩上下文”的命令。选择该命令 SHALL 直接触发宿主压缩动作，不得发送命令文本到会话。

#### Scenario: 从菜单选择 /compact
- **WHEN** 用户在斜杠菜单选择“压缩上下文”
- **THEN** 菜单关闭，宿主收到压缩请求，输入框不保留 `/compact` 文本
