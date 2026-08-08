## ADDED Requirements

### Requirement: HistoryLoader SHALL trigger compaction by message count and token count
The compaction trigger logic SHALL use dual thresholds: a token-based threshold (existing behavior) and a message-count threshold (default 40 messages). Compaction SHALL trigger when either threshold is exceeded. The message-count threshold SHALL be configurable via `yunxiaoAgent.compaction.messageThreshold`.

#### Scenario: Message count triggers compaction
- **WHEN** a session has 41 messages but token count is below the token threshold
- **THEN** compaction SHALL be triggered

#### Scenario: Token count triggers compaction
- **WHEN** a session has 15 messages but token count exceeds the token threshold
- **THEN** compaction SHALL be triggered

#### Scenario: Neither threshold exceeded
- **WHEN** a session has 30 messages and token count is below the token threshold
- **THEN** compaction SHALL NOT be triggered

### Requirement: AgentLoop SHALL check compaction after tool execution
In addition to the existing compaction check at the start of each loop iteration, the AgentLoop SHALL perform a compaction check after all tool calls in a step have been executed and their results appended to MessageStore.

#### Scenario: Compaction triggered after tool execution
- **WHEN** tool results are appended and the message count exceeds the threshold
- **THEN** compaction SHALL be triggered before the next LLM call

#### Scenario: No compaction needed after tool execution
- **WHEN** tool results are appended and neither threshold is exceeded
- **THEN** no compaction SHALL occur, and the loop SHALL proceed to the next iteration
