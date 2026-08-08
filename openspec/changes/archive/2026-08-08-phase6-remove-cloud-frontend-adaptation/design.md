## Context

Phases 1-5 of the refactoring have been completed: local LLM connection layer (`src/llm/`), memory management (`src/memory/`), Agent Loop (`src/agent/agentLoop.ts`), system prompt + Skill system (`src/agent/systemPrompt.ts`, `src/skill/`), and context compaction (`src/agent/compaction.ts`). All five modules are tested and functional.

However, the extension entry point (`src/extension.ts`) and the webview provider (`src/chatPanel.ts`) still use the old cloud-based architecture. The `AIClient` communicates with a cloud LangGraph service via HTTP/SSE. The `SessionManager` orchestrates cloud Run API calls. The `RunStore` persists cloud Run snapshots. The `RollbackManager` calls cloud rollback APIs. The `protocol/` directory handles cloud SSE events.

The plugin currently has two parallel, disconnected code paths: the new local Agent Loop (unused by the frontend) and the old cloud orchestration (active). Phase 6 connects the new local path to the frontend and removes the old cloud path.

## Goals / Non-Goals

**Goals:**
- Remove all cloud communication code so the plugin operates entirely locally
- Wire ChatPanel to use `AgentLoop.run()` for message sending and `AgentLoop.cancel()` for stopping
- Initialize all local modules (ModelConfig, LLMProvider, MessageStore, SkillRegistry, AgentLoop) in `extension.ts`
- Update configuration in `package.json` to reflect local-only operation
- Fix event payload field name mismatches between AgentLoop and ChatPanel
- Remove ToolRouter cloud-site check since all tools are now local

**Non-Goals:**
- Implementing local rollback (cloud rollback feature is simply removed; local rollback would require tracking file versions and is out of scope)
- Adding new model configuration UI beyond basic display (full settings UI is a future concern)
- Modifying tool implementations (tools already work; only the router's cloud check changes)
- Changing EventBus event types (existing types are reused; only payload field names are normalized)

## Decisions

### Decision 1: Delete SessionManager entirely, use thin wrapper

**Choice**: Replace `SessionManager` with a thin `LocalSessionManager` that maps `sessionId` to `AgentLoop` and delegates `sendMessage` / `cancel` / history loading.

**Rationale**: The old `SessionManager` is 750+ lines of cloud SSE orchestration logic. The new `AgentLoop` already handles the full loop internally. A thin wrapper preserves the `sessionId` mapping and history loading without duplicating orchestration logic.

**Alternative considered**: Use `AgentLoop` directly in `ChatPanel`. Rejected because session lifecycle (create, switch, list, history) needs a coordinator that `AgentLoop` doesn't provide.

### Decision 2: ChatPanel loads history from MessageStore, not cloud API

**Choice**: Replace `this._client.getHistory(sessionId)` with `this._messageStore.loadHistory(sessionId)` and convert `Message[]` to the webview's expected format.

**Rationale**: History is now stored locally in `MessageStore` (Phase 2). No cloud API call needed. The `MessageStore.loadHistory()` returns `Message[]` which is converted to `{role, content}` pairs for the frontend.

### Decision 3: Remove agent selector from UI

**Choice**: Remove the agent dropdown and `requestAgents` / `createSession` message handlers. Replace with a model info display showing the configured model name.

**Rationale**: In local mode, there's no agent list to fetch from a cloud service. The model is configured in VSCode settings. The agent selector UI adds complexity with no purpose in local mode.

### Decision 4: Fix AgentLoop event payload field names for frontend compatibility

**Choice**: Change `AgentLoop`'s `tool_state_change` event payload from `{ callId, tool, state }` to `{ call_id, tool, state, error?, args?, output? }` to match what `ChatPanel._forwardEvent()` expects.

**Rationale**: `ChatPanel._forwardEvent()` reads `e.payload.call_id`, `e.payload.tool`, `e.payload.state`, etc. The current `AgentLoop` emits `{ callId, tool, state }` (camelCase). This mismatch would break tool state display in the UI. Also fix `content` event payload from `{ text: ... }` to a plain string (ChatPanel expects `e.payload as string`).

### Decision 5: Remove `site` field from ToolCall, simplify ToolRouter

**Choice**: Remove `ExecutionSite` type, remove `site` field from `ToolCall` and `ToolSchema`, and remove the `call.site !== 'local'` check in `ToolRouter.route()`.

**Rationale**: With no cloud tools, the `site` field is meaningless. Keeping it would require setting it to `'local'` everywhere, which is dead code. The `toolAdapter.ts` already hardcodes `site: 'local'` - removing it simplifies the type system.

**Alternative considered**: Keep `site` field but always set to `'local'`. Rejected as it's unnecessary complexity that suggests cloud support exists when it doesn't.

### Decision 6: Remove rollback and manual compress from UI

**Choice**: Remove the rollback command, rollback button in message actions, and the compact button. Remove `compressSession` and `rollbackSession` message handlers from ChatPanel.

**Rationale**: Rollback is a cloud-only feature (requires cloud API to replay conversation state). Manual compression is replaced by automatic compaction in AgentLoop (Phase 5). Keeping non-functional UI elements would confuse users.

### Decision 7: Configuration changes in package.json

**Choice**: Remove `yunxiaoAgent.serviceBaseUrl`. Add `yunxiaoAgent.agent.maxSteps` (default 50), `yunxiaoAgent.agent.systemPrompt` (default ""), `yunxiaoAgent.compaction.enabled` (default true), `yunxiaoAgent.compaction.keepTokens` (default 8000), `yunxiaoAgent.compaction.buffer` (default 20000). The `yunxiaoAgent.skills.directories` config already exists.

**Rationale**: The old `serviceBaseUrl` pointed to the cloud service which no longer exists. The new configs expose AgentLoop and compaction settings to users. These are read by `ModelConfig` (Phase 1) and `AgentLoopConfig` (Phase 3) which already exist.

## Risks / Trade-offs

- **[Breaking change for existing users]** Users who upgrade will lose cloud connectivity. Mitigation: The plugin now requires `yunxiaoAgent.model.apiKey` configuration; document this in release notes.
- **[History format mismatch]** `MessageStore` stores `Message[]` with rich types (system/user/assistant/tool/compaction), but ChatPanel expects simple `{role, content}` pairs. Mitigation: Add a conversion function that maps `Message` to the webview format, filtering out `system` and `compaction` messages.
- **[Event payload normalization]** AgentLoop emits events with slightly different payload shapes than what the old SessionManager emitted. Mitigation: Audit all event types in `_forwardEvent()` and normalize AgentLoop payloads to match.
- **[Test coverage]** Deleting cloud tests removes significant test coverage. Mitigation: Add integration tests for the new local path in task 6.7.
- **[Rollback removal]** Users who relied on rollback will lose the feature. Mitigation: Acceptable trade-off; local rollback is a future enhancement.
