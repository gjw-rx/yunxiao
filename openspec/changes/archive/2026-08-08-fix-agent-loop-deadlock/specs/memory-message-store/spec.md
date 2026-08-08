## ADDED Requirements

### Requirement: Compaction summary SHALL preserve failed attempts and completed work
The compaction summary prompt template SHALL include structured fields for "Failed Attempts" and "Completed Work". The "Failed Attempts" field SHALL list each tool call that returned an error status, including the tool name, arguments, and error message. The "Completed Work" field SHALL list successfully executed tool calls and their key outcomes. This ensures the LLM does not re-attempt failed operations after context compression.

#### Scenario: Failed attempt preserved in summary
- **WHEN** a tool call `read_file({path: "/nonexistent"})` returned an error, and compaction is triggered
- **THEN** the compaction summary prompt SHALL include the failed attempt under "Failed Attempts"

#### Scenario: Completed work preserved in summary
- **WHEN** a tool call `write_file` succeeded and compaction is triggered
- **THEN** the compaction summary prompt SHALL include the completed work under "Completed Work"

#### Scenario: No failed attempts or completed work
- **WHEN** compaction is triggered and no tools were called or all calls are pending
- **THEN** the "Failed Attempts" and "Completed Work" fields SHALL be present but empty
