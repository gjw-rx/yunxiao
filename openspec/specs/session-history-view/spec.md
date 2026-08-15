# session-history-view Specification

## Purpose
历史会话入口内嵌在对话面板头部：新建会话按钮旁提供「历史」按钮，点击展开下拉列表，展示当前 workspace 的全部会话（标题、相对时间、消息数）。点击列表项将历史消息加载进对话框，可回放或继续对话；列表项提供删除按钮（经确认后删除）。会话数据变更后下拉列表在下次打开时自动获取最新数据。
## Requirements
### Requirement: 对话面板历史下拉列表
扩展 SHALL 在对话面板头部提供按“新建会话”“设置”“历史会话”排列的操作入口；点击“历史会话”后展开下拉列表，列出当前 workspace 的全部会话，按最近更新时间降序排列；每个列表项显示会话标题（无标题显示「新会话」）、相对时间与消息数；无会话时显示空状态文案。下拉列表每次展开时 SHALL 向扩展主进程请求最新会话列表（`requestSessions`），扩展回推 `sessionList` 后渲染，无需常驻订阅。

#### Scenario: 展示会话列表
- **WHEN** 当前 workspace 存在 3 个会话（更新时间不同），用户点击“历史会话”按钮
- **THEN** 下拉列表显示 3 个列表项，按 `updatedAt` 降序排列，每项含标题、相对时间与消息数

#### Scenario: 无会话时显示空状态
- **WHEN** 当前 workspace 尚无任何会话，用户点击“历史会话”按钮
- **THEN** 下拉列表显示空状态文案，不报错

#### Scenario: 点击外部关闭
- **WHEN** 下拉列表展开后用户点击列表外部区域
- **THEN** 下拉列表关闭，不影响对话内容

### Requirement: 回放历史会话
用户点击下拉列表中的会话项时，系统 SHALL 将 `currentSessionId` 切换为目标会话并加载该会话的全部历史消息（用户消息、助手回复、折叠展示的工具调用、token 消耗），供只读回放；会话标题同步展示在头部输入框。

#### Scenario: 点击会话加载历史
- **WHEN** 用户在历史下拉点击会话 `s1`（标题「重构登录模块」）
- **THEN** 对话框切换为 `s1` 并渲染其历史消息，前端 `currentSessionId` 更新为 `s1`，头部输入框显示「重构登录模块」

### Requirement: 继续历史会话
系统 SHALL 支持对历史会话继续对话（resume）：将 `currentSessionId` 切换为目标会话后，`AgentLoop.run` SHALL 从存储加载该会话完整历史（含 compaction 检查点）作为上下文，新消息 SHALL 追加到该会话文件。

#### Scenario: 继续历史会话发消息
- **WHEN** 用户通过历史下拉打开会话 `s1` 后发送新消息
- **THEN** 新消息及后续往返追加到 `s1.jsonl`，LLM 上下文包含 `s1` 既有历史

### Requirement: 删除历史会话
下拉列表每个会话项 SHALL 提供删除按钮；点击后由扩展主进程弹出模态确认提示（`showWarningMessage`），确认后删除该会话的 JSONL 文件与索引条目，并回推最新 `sessionList` 刷新列表。删除的是当前会话时，SHALL 一并复位前端会话指针与流式状态（若正在流式则停止），输入区回到待新建会话状态。

#### Scenario: 确认后删除
- **WHEN** 用户点击删除按钮并确认删除会话 `s1`
- **THEN** `s1.jsonl` 与索引条目被移除，下拉列表不再显示 `s1`；若 `s1` 是当前会话，对话框回到空状态

#### Scenario: 取消删除
- **WHEN** 用户点击删除按钮但取消确认
- **THEN** 会话数据保持不变，下拉列表仍显示该会话

#### Scenario: 删除非当前会话不打断当前流式回复
- **WHEN** 当前会话 `s2` 正在流式回复，用户删除历史会话 `s1`
- **THEN** `s1` 被删除，`s2` 的流式回复不受影响（不触发 Agent Loop 取消）

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

