## ADDED Requirements

### Requirement: AgentLoop SHALL check compaction after tool execution
In addition to the existing compaction check at the start of each loop iteration, the AgentLoop SHALL perform a compaction check after all tool calls in a step have been executed and their results appended to MessageStore.

#### Scenario: Compaction triggered after tool execution
- **WHEN** tool results are appended and the message count exceeds the threshold
- **THEN** compaction SHALL be triggered before the next LLM call

#### Scenario: No compaction needed after tool execution
- **WHEN** tool results are appended and neither threshold is exceeded
- **THEN** no compaction SHALL occur, and the loop SHALL proceed to the next iteration
