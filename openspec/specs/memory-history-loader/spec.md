## ADDED Requirements

### Requirement: HistoryLoader SHALL load messages from the latest compaction checkpoint

The `loadHistoryForLLM(sessionId, messageStore)` method SHALL find the latest CompactionMessage and return messages starting from that checkpoint. If no compaction exists, it SHALL return all messages.

#### Scenario: Session with compaction checkpoint
- **WHEN** `loadHistoryForLLM` is called for a session with a CompactionMessage at seq 10 and messages at seq 11-15
- **THEN** the returned array SHALL contain the compaction summary (as a system message) followed by messages from seq 11 to 15

#### Scenario: Session without compaction
- **WHEN** `loadHistoryForLLM` is called for a session with messages at seq 0-5 and no CompactionMessage
- **THEN** the returned array SHALL contain all 6 messages converted to LLMMessage format

### Requirement: HistoryLoader SHALL convert CompactionMessage to system message

When encountering a CompactionMessage, the HistoryLoader SHALL convert it to an `LLMMessage` with `role: "system"` and `content` set to the compaction summary text. The `recentContext` messages SHALL be expanded as individual LLMMessages following the system message.

#### Scenario: Compaction with recent context
- **WHEN** a CompactionMessage has `summary = "Summary text"` and `recentContext = [userMsg, assistantMsg]`
- **THEN** the output SHALL be `[systemMsg("Summary text"), userLLMMsg, assistantLLMMsg]`

#### Scenario: Compaction with empty recent context
- **WHEN** a CompactionMessage has `summary = "Summary text"` and `recentContext = []`
- **THEN** the output SHALL be `[systemMsg("Summary text")]`

### Requirement: HistoryLoader SHALL convert Message types to LLMMessage types

The HistoryLoader SHALL strip `seq` from all messages. It SHALL convert `UserMessage.attachments` by inlining attachment content into the message content text. It SHALL preserve `AssistantMessage.toolCalls` and `ToolMessage.toolCallId` as-is.

#### Scenario: Convert user message without attachments
- **WHEN** a UserMessage with `content = "hello"` and no attachments is converted
- **THEN** the LLMMessage SHALL have `role: "user"` and `content: "hello"`

#### Scenario: Convert user message with attachments
- **WHEN** a UserMessage with `content = "read this"` and one attachment `{ path: "/a.ts", content: "code", mimeType: "text/plain" }` is converted
- **THEN** the LLMMessage SHALL have `role: "user"` and `content` SHALL include the original text and the attachment content

#### Scenario: Convert assistant message with tool calls
- **WHEN** an AssistantMessage with `content = ""` and `toolCalls = [{ id: "1", name: "read_file", arguments: "{}" }]` is converted
- **THEN** the LLMMessage SHALL have `role: "assistant"`, `content: ""`, and `toolCalls` preserved

#### Scenario: Convert tool message
- **WHEN** a ToolMessage with `toolCallId = "1"` and `content = "result"` is converted
- **THEN** the LLMMessage SHALL have `role: "tool"`, `toolCallId: "1"`, and `content: "result"`

### Requirement: HistoryLoader SHALL handle empty sessions

When the session has no messages, `loadHistoryForLLM` SHALL return an empty array.

#### Scenario: Empty session
- **WHEN** `loadHistoryForLLM` is called for a session with no messages
- **THEN** an empty array SHALL be returned
