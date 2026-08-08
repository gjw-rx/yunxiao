## 1. Fix AgentLoop event payload compatibility

- [ ] 1.1 Fix `content` event payload in `agentLoop.ts` - change from `{ text: event.text }` to plain string `event.text` (ChatPanel `_forwardEvent` expects `e.payload as string`)
- [ ] 1.2 Fix `tool_state_change` event payload in `agentLoop.ts` - change `callId` to `call_id`, add `tool`, `state`, `error?`, `args?`, `output?` fields to match ChatPanel's `_forwardEvent` expectations
- [ ] 1.3 Fix `error` event payload in `agentLoop.ts` - change from `{ error: event.error }` to plain string `event.error` (ChatPanel expects `e.payload as string`)
- [ ] 1.4 Fix `token_usage` event payload - ensure `input_length` is the token count or message count, consistent with what ChatPanel expects
- [ ] 1.5 Verify all EventBus event types emitted by AgentLoop are handled by ChatPanel `_forwardEvent`

## 2. Remove cloud site from types and ToolRouter

- [ ] 2.1 Remove `ExecutionSite` type from `src/core/types.ts`
- [ ] 2.2 Remove `site` field from `ToolCall` interface in `src/core/types.ts`
- [ ] 2.3 Remove `site` field from `ToolSchema` interface in `src/core/types.ts`
- [ ] 2.4 Remove `site: 'local' as const` from `llmToolCallToCoreToolCall` in `src/agent/toolAdapter.ts`
- [ ] 2.5 Remove `site` filter from `toolSchemasToDefinitions` in `src/agent/toolAdapter.ts`
- [ ] 2.6 Remove cloud site check (`call.site !== 'local'`) and `ProtocolError` throw from `ToolRouter.route()` in `src/core/toolRouter.ts`
- [ ] 2.7 Remove cloud site check from `ToolRouter.canRunInParallel()` in `src/core/toolRouter.ts`
- [ ] 2.8 Remove `require_approval` field from `ToolCall` interface (no longer needed)
- [ ] 2.9 Update `localSchemas()` method on `ToolRegistry` - remove or simplify since no cloud reporting needed
- [ ] 2.10 Update all tool schema declarations to remove `site` field (fs/, code/, terminal/, git/, skill)

## 3. Create LocalSessionManager

- [ ] 3.1 Create `src/core/localSessionManager.ts` with `LocalSessionManager` class
- [ ] 3.2 Implement `createSession()` - generate UUID-based session ID, return it
- [ ] 3.3 Implement `sendMessage(sessionId, text)` - delegate to `AgentLoop.run(sessionId, text)`
- [ ] 3.4 Implement `cancel(sessionId)` - delegate to `AgentLoop.cancel()`
- [ ] 3.5 Implement `loadHistory(sessionId)` - load from `MessageStore`, convert `Message[]` to `{role, content}[]`, filter out `system` and `compaction` messages
- [ ] 3.6 Implement `reset(sessionId)` - cancel AgentLoop, clear MessageStore for session
- [ ] 3.7 Implement `getCurrentSessionId()` getter

## 4. Rewrite ChatPanel for local mode

- [ ] 4.1 Update `ChatViewDeps` interface - replace `client: AIClient`, `sessionManager: SessionManager`, `rollbackManager: RollbackManager` with `sessionManager: LocalSessionManager`, `messageStore: MessageStore`
- [ ] 4.2 Remove `getServiceBaseUrl()` function and `_baseUrl` property
- [ ] 4.3 Remove `friendlyError()` function (cloud-specific error messages)
- [ ] 4.4 Remove `requestAgents` message handler
- [ ] 4.5 Remove `createSession` message handler - replace with local session creation via `LocalSessionManager.createSession()`
- [ ] 4.6 Update `sendMessage` handler - call `LocalSessionManager.sendMessage()` instead of cloud `SessionManager.sendMessage()`
- [ ] 4.7 Remove `compressSession` message handler (automatic compaction now)
- [ ] 4.8 Update `stopStream` handler - call `LocalSessionManager.cancel()` instead of cloud `SessionManager.cancel()`
- [ ] 4.9 Update `loadHistory` handler - call `LocalSessionManager.loadHistory()` instead of `AIClient.getHistory()`
- [ ] 4.10 Remove `rollbackSession` message handler
- [ ] 4.11 Remove `showHistory` handler (cloud session list no longer exists) - replace with local session list if needed
- [ ] 4.12 Remove `renameSession` handler dependency on cloud (keep local name mapping)
- [ ] 4.13 Remove `_compressingSessions` set and related logic
- [ ] 4.14 Remove config listener for `serviceBaseUrl`
- [ ] 4.15 Update `_forwardEvent` to handle the fixed AgentLoop event payloads
- [ ] 4.16 Remove agent selector UI from webview HTML (agent dropdown, `requestAgents` init message)
- [ ] 4.17 Add model info display in webview header (show configured model name from config)
- [ ] 4.18 Remove compact button from webview HTML and JS
- [ ] 4.19 Remove rollback button from user message action bar in webview JS
- [ ] 4.20 Update `startNewSession()` JS function - call local session creation instead of `createSession` with `agentId`
- [ ] 4.21 Remove `vscode.postMessage({ command: 'requestAgents' })` init call

## 5. Rewrite extension.ts entry point

- [ ] 5.1 Remove imports for `AIClient`, cloud `SessionManager`, `RunStore`, `RollbackManager`, `ToolExecutionJournal`, `ReliabilityMetrics`
- [ ] 5.2 Add imports for `ModelConfig`, `createProvider`, `MessageStore`, `AgentLoop`, `LocalSessionManager`, `AgentLoopConfig`
- [ ] 5.3 Remove `getServiceBaseUrl()` function
- [ ] 5.4 Remove `AIClient` initialization
- [ ] 5.5 Remove `RollbackManager` initialization
- [ ] 5.6 Remove `RunStore` initialization
- [ ] 5.7 Remove `ToolExecutionJournal` initialization (if ToolRouter no longer requires it)
- [ ] 5.8 Remove `ReliabilityMetrics` initialization
- [ ] 5.9 Initialize `ModelConfig` - read from VSCode configuration
- [ ] 5.10 Initialize `LLMProvider` via `createProvider(config)`
- [ ] 5.11 Initialize `MessageStore` with `context.workspaceState`
- [ ] 5.12 Initialize `AgentLoop` with provider, messageStore, toolRouter, toolRegistry, eventBus, and `AgentLoopConfig`
- [ ] 5.13 Initialize `LocalSessionManager` with agentLoop and messageStore
- [ ] 5.14 Update `ChatViewProvider` constructor deps to use `LocalSessionManager` and `MessageStore`
- [ ] 5.15 Remove rollback command registration
- [ ] 5.16 Remove `runStore.listRestorable()` loop and `sessionManager.restoreRun()` calls
- [ ] 5.17 Remove circular dependency backfill (`_registry`, `_sessionManager` assignment)
- [ ] 5.18 Update `ApprovalGateway` prompter to work without cloud sessionManager

## 6. Update package.json configuration

- [ ] 6.1 Remove `yunxiaoAgent.serviceBaseUrl` configuration property
- [ ] 6.2 Add `yunxiaoAgent.agent.maxSteps` (type: number, default: 50, scope: window)
- [ ] 6.3 Add `yunxiaoAgent.agent.systemPrompt` (type: string, default: "", scope: window)
- [ ] 6.4 Add `yunxiaoAgent.compaction.enabled` (type: boolean, default: true, scope: window)
- [ ] 6.5 Add `yunxiaoAgent.compaction.keepTokens` (type: number, default: 8000, scope: window)
- [ ] 6.6 Add `yunxiaoAgent.compaction.buffer` (type: number, default: 20000, scope: window)
- [ ] 6.7 Remove rollback command from `contributes.commands`

## 7. Delete cloud code files

- [ ] 7.1 Delete `src/aiClient.ts`
- [ ] 7.2 Delete `src/protocol/toolCallProtocol.ts`
- [ ] 7.3 Delete `src/protocol/sseHandler.ts`
- [ ] 7.4 Delete `src/core/sessionManager.ts`
- [ ] 7.5 Delete `src/core/runStore.ts`
- [ ] 7.6 Delete `src/core/rollbackManager.ts`
- [ ] 7.7 Delete `src/test/aiClient.test.ts`
- [ ] 7.8 Delete `src/test/protocol/sseHandler.test.ts`
- [ ] 7.9 Delete `src/test/protocol/toolCallProtocol.test.ts`
- [ ] 7.10 Delete `src/test/core/sessionManager.test.ts`
- [ ] 7.11 Delete `src/test/core/runStore.test.ts`
- [ ] 7.12 Remove `ProtocolError` from `src/core/errors.ts` if no longer used
- [ ] 7.13 Remove unused imports across codebase (cloud types, AIClient references)

## 8. Compile and fix errors

- [ ] 8.1 Run `npm run compile` and fix all TypeScript errors
- [ ] 8.2 Run `npm run lint` and fix lint errors
- [ ] 8.3 Verify no remaining imports of deleted modules
- [ ] 8.4 Verify no remaining references to `AIClient`, `RunStore`, `RollbackManager`, `SessionManager` (cloud), `protocol/`

## 9. Update and add tests

- [ ] 9.1 Update `src/test/chatPanel.test.ts` for new deps and message handlers
- [ ] 9.2 Update `src/test/extension.test.ts` for new initialization flow
- [ ] 9.3 Update `src/test/core/toolRouter.test.ts` - remove cloud site test cases
- [ ] 9.4 Update `src/test/core/toolRegistry.test.ts` - remove `site` field assertions
- [ ] 9.5 Add test for `LocalSessionManager` - session creation, message delegation, cancel, history loading
- [ ] 9.6 Update `src/test/tools/baseTool.test.ts` - remove `site` field assertions
- [ ] 9.7 Run `npm test` and ensure all tests pass

## 10. End-to-end verification

- [ ] 10.1 Test scenario: Simple conversation (no tool calls) - send message, receive streaming reply
- [ ] 10.2 Test scenario: Read file and answer - LLM calls `fs.read_file`, result feeds back, LLM responds
- [ ] 10.3 Test scenario: Edit file with approval - LLM calls `code.edit`, approval card shows, user approves, file is edited
- [ ] 10.4 Test scenario: Terminal command with approval - LLM calls `terminal.exec`, approval shows, command runs
- [ ] 10.5 Test scenario: Git operations - LLM calls `git.status` / `git.diff` etc.
- [ ] 10.6 Test scenario: Long conversation triggers automatic compaction
- [ ] 10.7 Test scenario: Skill loading - LLM calls `skill` tool to load skill content
- [ ] 10.8 Test scenario: Interrupt handling - user clicks stop during streaming
