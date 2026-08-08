## ADDED Requirements

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
