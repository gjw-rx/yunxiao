# frontend-local-adaptation Specification

## Purpose
TBD - created by syncing delta from phase6-remove-cloud-frontend-adaptation. Update Purpose after archive.
## Requirements
### Requirement: ChatPanel uses local AgentLoop for messaging
The `ChatViewProvider` SHALL delegate message sending to `AgentLoop.run(sessionId, text)` via `LocalSessionManager.sendMessage()` instead of cloud `SessionManager.sendMessage()`. It SHALL delegate stream stopping to `AgentLoop.cancel()` via `LocalSessionManager.cancel()` instead of cloud `SessionManager.cancel()`. The `ChatViewDeps` interface SHALL replace `AIClient`, cloud `SessionManager`, and `RollbackManager` with `LocalSessionManager` and `MessageStore`.

#### Scenario: User sends a message
- **WHEN** the user clicks send with text "hello" and session "session-1"
- **THEN** `LocalSessionManager.sendMessage('session-1', 'hello')` is called, which invokes `AgentLoop.run('session-1', 'hello')`

#### Scenario: User stops a stream
- **WHEN** the user clicks the stop button during an active stream
- **THEN** `LocalSessionManager.cancel('session-1')` is called, which invokes `AgentLoop.cancel()`

### Requirement: ChatPanel loads history from local MessageStore
The `ChatViewProvider` SHALL load conversation history from `MessageStore` via `LocalSessionManager.loadHistory()` instead of calling `AIClient.getHistory()`. The loaded messages SHALL be converted from `Message[]` to the webview format `{role, content}`.

#### Scenario: Session created triggers local history load
- **WHEN** a new session is created
- **THEN** the frontend posts `loadHistory` and the provider returns messages from `MessageStore`, or an empty array for a new session

### Requirement: ChatPanel removes cloud-only message handlers
The `ChatViewProvider` SHALL remove the following message handlers: `requestAgents`, `createSession`, `compressSession`, `rollbackSession`. It SHALL remove the `showHistory` handler that listed cloud sessions. The `sendMessage` handler SHALL no longer reference `AIClient` or cloud `SessionManager`.

#### Scenario: requestAgents handler removed
- **WHEN** the webview sends a `requestAgents` message
- **THEN** no action is taken (handler is removed; agent list is no longer fetched from cloud)

#### Scenario: compressSession handler removed
- **WHEN** the webview sends a `compressSession` message
- **THEN** no action is taken (compaction is now automatic via AgentLoop)

#### Scenario: rollbackSession handler removed
- **WHEN** the webview sends a `rollbackSession` message
- **THEN** no action is taken (rollback is a cloud-only feature, removed in local mode)

### Requirement: ChatPanel event forwarding compatibility
The `ChatViewProvider._forwardEvent()` SHALL correctly handle events emitted by the local `AgentLoop`. The `content` event payload SHALL be a plain string (not `{text: string}`). The `tool_state_change` event payload SHALL use `call_id` (snake_case), not `callId` (camelCase), and SHALL include `tool`, `state`, `error?`, `args?`, and `output?` fields.

#### Scenario: Content event forwarded as plain string
- **WHEN** AgentLoop emits a `content` event with payload `{ text: "hello" }`
- **THEN** `_forwardEvent` extracts the text and posts `{ command: 'replyChunk', text: "hello" }` to the webview

#### Scenario: Tool state change forwarded with call_id
- **WHEN** AgentLoop emits a `tool_state_change` event with payload `{ call_id: "c1", tool: "fs.read_file", state: "running" }`
- **THEN** `_forwardEvent` posts `{ command: 'toolState', call_id: "c1", state: "running", tool: "fs.read_file" }` to the webview

### Requirement: Tool call pending state in webview
The webview SHALL handle `toolCall` postMessage commands by creating a tool step with `pending` state in the trace timeline, showing the tool name, arguments preview, and a pending status icon, before the tool starts executing.

#### Scenario: Tool call received before execution
- **WHEN** the webview receives `{ command: 'toolCall', call_id, tool, args }`
- **THEN** a tool step element is created in the trace with `pending` state, displaying the tool icon, tool name, and argument summary

#### Scenario: Pending state transitions to running
- **WHEN** a tool step already exists with `pending` state and the webview receives `{ command: 'toolState', state: 'running' }` for the same `call_id`
- **THEN** the existing tool step is updated to `running` state without creating a duplicate element

### Requirement: Diff card rendering for code.edit
The ChatViewProvider SHALL detect `code.edit` tool success results that contain diff metadata and forward them to the webview as `diffResult` commands, activating the existing `showDiffCard` rendering.

#### Scenario: code.edit success with diff
- **WHEN** a `tool_state_change` event arrives with `tool === 'code.edit'`, `state === 'success'`, and the output contains diff data
- **THEN** the ChatViewProvider posts `{ command: 'diffResult', call_id, file_path, diff_html, additions, deletions }` to the webview

#### Scenario: Non-edit tool success does not trigger diff card
- **WHEN** a `tool_state_change` event arrives for a tool other than `code.edit`
- **THEN** no `diffResult` command is posted

### Requirement: History restoration of tool call steps
The webview SHALL render tool call steps from history when a session is loaded, restoring the trace timeline with tool name, arguments, and results.

#### Scenario: Loading history with tool calls
- **WHEN** the webview receives `historyLoaded` messages containing `assistant` messages with `toolCalls` and `tool` role messages
- **THEN** each tool call is rendered as a tool step in the trace timeline, showing tool name, arguments, and result content

#### Scenario: Loading history without tool calls
- **WHEN** the webview receives `historyLoaded` messages containing only `user` and `assistant` messages without `toolCalls`
- **THEN** no tool steps are rendered in the trace timeline

### Requirement: Extension entry initializes local modules
The `extension.ts` `_activate()` function SHALL initialize `ModelConfig`, `LLMProvider` (via provider factory), `MessageStore`, `SkillRegistry` (scanning configured skill directories), `ToolRegistry` (registering all tools), `ToolRouter`, and `AgentLoop` (with `AgentLoopConfig` from configuration). It SHALL remove initialization of `AIClient`, cloud `SessionManager`, `RunStore`, `RollbackManager`, and `ToolExecutionJournal` (if no longer needed by the simplified ToolRouter).

#### Scenario: Extension activates with local modules
- **WHEN** the extension is activated
- **THEN** `ModelConfig` reads from VSCode configuration, `createProvider()` creates an `LLMProvider`, `MessageStore` is instantiated, `SkillRegistry` loads skills, `AgentLoop` is constructed with the provider, messageStore, toolRouter, toolRegistry, and eventBus

#### Scenario: Extension does not initialize cloud modules
- **WHEN** the extension is activated
- **THEN** no `AIClient`, `RunStore`, `RollbackManager`, or cloud `SessionManager` instances are created

### Requirement: Configuration reflects local-only operation
The `package.json` configuration SHALL remove `yunxiaoAgent.serviceBaseUrl`. It SHALL add `yunxiaoAgent.agent.maxSteps` (default 50), `yunxiaoAgent.agent.systemPrompt` (default ""), `yunxiaoAgent.compaction.enabled` (default true), `yunxiaoAgent.compaction.keepTokens` (default 8000), and `yunxiaoAgent.compaction.buffer` (default 20000).

#### Scenario: serviceBaseUrl removed
- **WHEN** a user opens VSCode settings
- **THEN** `yunxiaoAgent.serviceBaseUrl` is not present

#### Scenario: Agent configuration available
- **WHEN** a user opens VSCode settings
- **THEN** `yunxiaoAgent.agent.maxSteps` and `yunxiaoAgent.agent.systemPrompt` are available with their defaults

#### Scenario: Compaction configuration available
- **WHEN** a user opens VSCode settings
- **THEN** `yunxiaoAgent.compaction.enabled`, `yunxiaoAgent.compaction.keepTokens`, and `yunxiaoAgent.compaction.buffer` are available with their defaults