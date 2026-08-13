# conversation-delete-rollback Specification

## Purpose
TBD - created by archiving change conversation-delete-rollback. Update Purpose after archive.
## Requirements
### Requirement: 删除单条用户消息级联删除整个 turn
系统 SHALL 支持删除单条用户消息。删除某条「非注入」用户消息（seq=X）时，SHALL 一并删除从 X 到下一条「非注入」用户消息之前的所有消息（该 turn 内的助手回复与工具结果）。系统注入的提示消息（step 预警、空回复提示、doom 引导）SHALL 以 `injected: true` 标记，不构成 turn 边界。

#### Scenario: 删除用户消息连带删除其 turn
- **WHEN** 用户删除一条 seq=5 的用户消息，其后有两条助手消息与两条工具结果，再往后才是下一条用户消息 seq=10
- **THEN** seq 5 到 9 的消息全部被删除，seq=10 的用户消息保留

#### Scenario: 注入消息不截断 turn
- **WHEN** 一个 turn 内存在 `injected: true` 的 step 预警消息（seq=7），用户删除该 turn 的真实用户消息 seq=5
- **THEN** seq=7 的注入消息及其后到下一真实用户消息之间的内容一并被删除

### Requirement: 删除带工具调用的助手消息级联删除其工具结果
系统 SHALL 支持删除单条助手消息。删除一条带 `toolCalls` 的助手消息时，SHALL 一并删除所有 `toolCallId` 匹配其 `toolCalls[].id` 的工具结果消息，避免遗留无归属的工具结果。

#### Scenario: 助手消息与工具结果一并删除
- **WHEN** 用户删除一条含两个 `toolCalls`（id 为 `a`、`b`）的助手消息
- **THEN** 该助手消息与 `toolCallId` 为 `a`、`b` 的两条工具结果消息全部被删除

### Requirement: 删除工具结果消息并清理孤立工具调用
系统 SHALL 支持删除单条工具结果消息。删除工具结果消息（`toolCallId` 为 `c`）时，SHALL 从对应助手消息的 `toolCalls` 中移除 `id === c` 的条目；若移除后该助手消息无 `toolCalls` 且正文为空，SHALL 一并删除该助手消息，保证发往模型的历史不含无应答的工具调用。

#### Scenario: 删除工具结果移除孤立工具调用
- **WHEN** 用户删除一条工具结果消息，其 `toolCallId` 为 `c`，对应助手消息的 `toolCalls` 含 `c` 与 `d` 两项
- **THEN** 该工具结果被删除，助手消息的 `toolCalls` 仅剩 `d` 一项，助手消息保留

#### Scenario: 删除唯一工具结果后删除空助手消息
- **WHEN** 用户删除一条工具结果消息，其对应助手消息的 `toolCalls` 仅含该项且正文为空
- **THEN** 该工具结果与这条空助手消息一并被删除

### Requirement: 删除消息持久化且不再参与后续请求
消息删除 SHALL 持久化到存储后端，并使被删消息不再出现在 `loadHistory` 结果与后续 LLM 请求的历史中。

#### Scenario: 删除后重载历史不含被删消息
- **WHEN** 删除 seq=5 的消息后重新加载该会话历史
- **THEN** 返回的消息列表不含 seq=5，后续 `AgentLoop` 请求 LLM 的历史亦不含该消息

### Requirement: 回滚用户输入 turn
系统 SHALL 支持对用户消息执行回滚（seq=X）。回滚 SHALL 截断消息到 X 之前（删除 X 及之后全部消息），并将 X 及之后各 turn 产生的文件改动恢复到 X 开始前的状态。仅「非注入」的用户消息可回滚。

#### Scenario: 回滚恢复文件并截断消息
- **WHEN** 用户对 seq=5 的用户消息执行回滚，该 turn 及其后修改了文件 `a.ts` 与新建了 `b.ts`
- **THEN** `a.ts` 恢复到 seq=5 之前的内容，`b.ts` 被删除，seq 5 及之后的全部消息被删除

#### Scenario: 仅用户消息可回滚
- **WHEN** 对助手消息或工具结果消息发起回滚
- **THEN** 系统拒绝该操作，不删除消息、不恢复文件

### Requirement: 回滚后用户输入回填输入框
回滚成功 SHALL 将被回滚用户消息的 `content` 回传给前端，前端 SHALL 将该内容写入消息输入框，供用户修改后重新发送。

#### Scenario: 输入回填
- **WHEN** 回滚 seq=5、内容为「重构登录模块」的用户消息
- **THEN** 前端输入框内容变为「重构登录模块」，消息列表已不含 seq 5 及之后内容

### Requirement: 写文件工具记录回滚快照
写文件类工具（`code_edit`、`fs_write_file`、`fs_delete_file`、`fs_move_file`）在执行成功前 SHALL 将目标路径的改动前状态复制到本地持久化回滚快照目录，按「会话 + 用户消息 seq」组织；目标原本不存在时 SHALL 记录为新建。回滚时按该快照恢复文件或删除新建文件。

#### Scenario: 覆盖写入前记录快照
- **WHEN** `fs_write_file` 覆盖已存在的 `a.ts`
- **THEN** 改动前 `a.ts` 的内容被复制到回滚快照目录，回滚该 turn 时 `a.ts` 恢复到改动前内容

#### Scenario: 新建文件回滚时删除
- **WHEN** `fs_write_file` 新建不存在的 `b.ts`
- **THEN** 快照记录 `b.ts` 为新建，回滚该 turn 时删除 `b.ts`

#### Scenario: 删除文件前记录快照
- **WHEN** `fs_delete_file` 删除已存在的 `c.ts`
- **THEN** 删除前 `c.ts` 的内容被复制到回滚快照目录，回滚该 turn 时 `c.ts` 被恢复

### Requirement: 回滚快照随回滚与会话删除清理
回滚某 turn 时 SHALL 清理该 turn 及之后各 turn 的回滚快照；删除会话时 SHALL 一并删除该会话的回滚快照目录，避免残留占位。

#### Scenario: 回滚清理快照
- **WHEN** 回滚 seq=5 的用户消息成功
- **THEN** `userSeq >= 5` 的回滚快照条目被删除

#### Scenario: 删除会话清理快照
- **WHEN** 删除会话 `s1`
- **THEN** `s1` 的回滚快照目录被删除，其他会话的快照保留

### Requirement: Change-review records follow turn rollback and session deletion
The system SHALL remove persisted change-review records for a session when that session is deleted. A rollback of user-message sequence X SHALL remove the change-review records whose originating sequence is X or later in the same session.

#### Scenario: Cleanup after session deletion
- **WHEN** a session containing persisted change-review records is deleted
- **THEN** its change-review records are deleted together with its messages and rollback snapshots

#### Scenario: Cleanup after turn rollback
- **WHEN** a user rolls back a turn with sequence X
- **THEN** all change-review records from sequence X onwards are removed

