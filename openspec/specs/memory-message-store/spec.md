## ADDED Requirements

### Requirement: MessageStore SHALL store messages with sequence numbers

The MessageStore SHALL assign a monotonically increasing `seq` number to each appended message within a session. The `seq` SHALL start at 0 and increment by 1 per message.

#### Scenario: Append first message to new session
- **WHEN** `append(sessionId, message)` is called on a session with no prior messages
- **THEN** the message SHALL be stored with `seq = 0`

#### Scenario: Append subsequent messages
- **WHEN** `append(sessionId, message)` is called after prior messages exist
- **THEN** the message SHALL be stored with `seq = (max existing seq) + 1`

### Requirement: MessageStore SHALL persist messages to workspaceState

The MessageStore SHALL serialize all sessions' messages to VSCode `workspaceState` (via injected `vscode.Memento`) on every `append` call. The storage key SHALL be `yunxiaoAgent.messages`.

#### Scenario: Persist after append
- **WHEN** a message is appended to any session
- **THEN** the full `Map<sessionId, Message[]>` SHALL be serialized as JSON and written to `workspaceState`

#### Scenario: Restore on construction
- **WHEN** MessageStore is constructed with a Memento containing persisted data
- **THEN** all sessions and their messages SHALL be restored into memory

#### Scenario: Persistence failure degradation
- **WHEN** `workspaceState.update()` throws an error
- **THEN** the message SHALL still be kept in memory, and the error SHALL be logged without throwing to the caller

### Requirement: MessageStore SHALL enforce 1000 message limit per session

The MessageStore SHALL limit each session to a maximum of 1000 messages. When the limit is reached, the oldest message SHALL be removed before appending the new one.

#### Scenario: Append at limit
- **WHEN** a session has 1000 messages and `append` is called
- **THEN** the oldest message (lowest seq) SHALL be removed, and the new message SHALL be appended

### Requirement: MessageStore SHALL support loading full history

The `loadHistory(sessionId)` method SHALL return all messages for the given session in seq order. If the session does not exist, it SHALL return an empty array.

#### Scenario: Load existing session history
- **WHEN** `loadHistory(sessionId)` is called for a session with 5 messages
- **THEN** an array of 5 messages ordered by seq ascending SHALL be returned

#### Scenario: Load non-existent session
- **WHEN** `loadHistory(sessionId)` is called for a session that was never created
- **THEN** an empty array SHALL be returned

### Requirement: MessageStore SHALL support finding the latest compaction checkpoint

The `getCompactionPoint(sessionId)` method SHALL return the most recent `CompactionMessage` for the session, or `null` if none exists.

#### Scenario: Session with compaction
- **WHEN** `getCompactionPoint(sessionId)` is called for a session containing one or more CompactionMessages
- **THEN** the CompactionMessage with the highest seq SHALL be returned

#### Scenario: Session without compaction
- **WHEN** `getCompactionPoint(sessionId)` is called for a session with no CompactionMessages
- **THEN** `null` SHALL be returned

### Requirement: MessageStore SHALL support clearing a session

The `clear(sessionId)` method SHALL remove all messages for the given session and persist the change.

#### Scenario: Clear existing session
- **WHEN** `clear(sessionId)` is called for a session with messages
- **THEN** the session's messages SHALL be removed from memory and workspaceState

### Requirement: MessageStore SHALL support deleting messages after a seq

The `deleteMessagesAfter(sessionId, seq)` method SHALL remove all messages with `seq >` the given value. This supports rollback operations.

#### Scenario: Delete messages after seq
- **WHEN** `deleteMessagesAfter(sessionId, 5)` is called on a session with messages at seq 0-9
- **THEN** messages with seq 6-9 SHALL be removed, messages with seq 0-5 SHALL remain

#### Scenario: Delete with no matching messages
- **WHEN** `deleteMessagesAfter(sessionId, 100)` is called on a session where max seq is 5
- **THEN** no messages SHALL be removed

### Requirement: Message types SHALL support attachments and tool calls

The `UserMessage` type SHALL include an optional `attachments` field (array of `{ path, content, mimeType }`). The `AssistantMessage` type SHALL include an optional `toolCalls` field (array of `{ id, name, arguments }`).

#### Scenario: User message with attachment
- **WHEN** a UserMessage is created with an attachment
- **THEN** the `attachments` field SHALL contain the attachment data

#### Scenario: Assistant message with tool calls
- **WHEN** an AssistantMessage is created with tool calls
- **THEN** the `toolCalls` field SHALL contain an array of `{ id, name, arguments }`
