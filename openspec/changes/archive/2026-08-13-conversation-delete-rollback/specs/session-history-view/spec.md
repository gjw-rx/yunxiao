# session-history-view Specification

## Purpose

历史会话入口内嵌在对话面板头部：新建会话按钮旁提供「历史」按钮，点击展开下拉列表，展示当前 workspace 的全部会话（标题、相对时间、消息数）。点击列表项将历史消息加载进对话框，可回放或继续对话；列表项提供删除按钮（经确认后删除）。会话数据变更后下拉列表在下次打开时自动获取最新数据。对话内消息支持逐条删除与用户消息回滚。

## ADDED Requirements

### Requirement: 对话内消息删除入口
对话面板 SHALL 为每条消息提供「删除」入口（hover 显示）。点击后 SHALL 通过消息协议向扩展宿主下发 `deleteMessage { sessionId, seq }`，由宿主持久化删除并回推最新历史刷新列表；前端 SHALL 不自行实现级联删除逻辑。

#### Scenario: 删除单条消息并刷新
- **WHEN** 用户点击某条消息的「删除」按钮
- **THEN** 宿主删除该消息及其配对消息，回推 `historyLoaded` 刷新消息列表，被删内容不再显示

### Requirement: 对话内用户消息回滚入口
对话面板 SHALL 仅对用户消息提供「回滚」入口。点击后 SHALL 弹出确认提示（删除消息并恢复文件、不可恢复），确认后向宿主下发 `rollbackTurn { sessionId, seq }`；宿主恢复文件、截断消息并回推 `historyLoaded` 与 `rollbackRestored { text }`，前端 SHALL 用 `text` 回填输入框。助手消息与工具结果 SHALL NOT 显示回滚入口。

#### Scenario: 确认后回滚
- **WHEN** 用户点击用户消息「回滚」并确认
- **THEN** 该 turn 及之后的文件改动被恢复、消息被截断，输入框回填该用户消息内容

#### Scenario: 取消回滚
- **WHEN** 用户点击「回滚」但取消确认
- **THEN** 消息与文件均保持不变

#### Scenario: 非用户消息无回滚入口
- **WHEN** 查看助手消息或工具结果消息
- **THEN** 该消息不显示「回滚」入口（仅显示「删除」）
