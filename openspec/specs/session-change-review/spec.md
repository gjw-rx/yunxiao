# session-change-review Specification

## Purpose
系统 SHALL 以会话为单位维护一份累积变更集（cumulative change set）：将当前工作区与首次 Agent run 前捕获的持久化基线对比，覆盖托管写工具、终端命令与 Git 提交产生的合格文件变更，为每次完成的助手回复提供一致的会话级代码变更审查入口。

## Requirements
### Requirement: Per-turn managed-file change sets
The system SHALL create one cumulative change set for each session by comparing the current workspace against a persistent baseline captured before the session's first Agent run. The change set SHALL include eligible text-file changes made through managed write tools, terminal commands, and Git commits after that baseline; it SHALL remain isolated by workspace and session ID and SHALL exclude `.git`, dependency, build, oversized, and non-text files.

#### Scenario: Terminal command commits session changes
- **WHEN** an Agent uses a terminal command to modify OpenSpec files and creates a Git commit during a session
- **THEN** the session's code-change action shows the committed files and their baseline-to-current contents

#### Scenario: Multiple replies modify different files
- **WHEN** consecutive replies in one session modify `a.ts` and then `b.ts`
- **THEN** the session code-change action shows both files as one cumulative change set

#### Scenario: Existing workspace change before session start
- **WHEN** a file is already modified before the session's first Agent run and the session does not change it
- **THEN** the file is absent from the session change set

### Requirement: Immutable review snapshots and aggregate file result
For each affected eligible path, the system SHALL retain the content from the session baseline and the current content when the cumulative change set is refreshed. The review result SHALL classify additions, modifications, and deletions and SHALL calculate summary additions and deletions from those stored states.

#### Scenario: File changes in separate replies
- **WHEN** a file is changed by one reply and changed again by a later reply in the same session
- **THEN** the review compares the original session baseline with the file's latest content

### Requirement: Dedicated change-review page
Every completed final assistant reply SHALL render a code-change action. The action SHALL show the current session cumulative affected-file count and aggregate line statistics when entries exist, and SHALL be disabled when none exist. Activating an enabled action SHALL open a dedicated WebviewPanel that lists the session change set's files and allows selecting a file to view its stored before/after diff.

#### Scenario: Open a historical reply's change action
- **WHEN** a user opens any final assistant reply in a session with cumulative changes
- **THEN** the dedicated panel shows the same current session cumulative change set

### Requirement: Change-record lifecycle cleanup
The system SHALL delete all baseline and cumulative change records for a session when that session is deleted. When a user turn is rolled back, the system SHALL refresh the session cumulative change set after the workspace rollback completes.

#### Scenario: Roll back a changed turn
- **WHEN** a user rolls back a turn that changed files
- **THEN** the session review refreshes to the post-rollback workspace state

