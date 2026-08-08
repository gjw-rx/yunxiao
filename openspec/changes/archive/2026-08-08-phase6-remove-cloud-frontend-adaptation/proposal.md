## Why

The plugin has completed Phases 1-5 (local LLM connection, memory management, Agent Loop, system prompt + Skill, context compaction), but the extension entry point, ChatPanel, and configuration still reference the old cloud-based architecture (`AIClient`, `SessionManager` with SSE Run API, `RunStore`, `RollbackManager`, `protocol/`). The plugin cannot function in local-only mode until these cloud dependencies are removed and the frontend is wired to the local `AgentLoop`.

## What Changes

- **BREAKING**: Delete `src/aiClient.ts`, `src/protocol/` directory (toolCallProtocol.ts, sseHandler.ts), `src/core/sessionManager.ts`, `src/core/runStore.ts`, `src/core/rollbackManager.ts` — all cloud communication code removed
- **BREAKING**: Rewrite `src/extension.ts` to initialize `ModelConfig`, `LLMProvider`, `MessageStore`, `SkillRegistry`, `AgentLoop` instead of `AIClient` / cloud `SessionManager` / `RunStore` / `RollbackManager`
- **BREAKING**: Rewrite `src/chatPanel.ts` — `sendMessage` calls `AgentLoop.run()` instead of cloud `SessionManager.sendMessage()`; `stopStream` calls `AgentLoop.cancel()`; remove `requestAgents` / `createSession` / `compressSession` / `loadHistory` (cloud) / `rollbackSession` message handlers; load history from local `MessageStore`
- **BREAKING**: Remove `yunxiaoAgent.serviceBaseUrl` configuration; add `yunxiaoAgent.agent.maxSteps`, `yunxiaoAgent.agent.systemPrompt`, `yunxiaoAgent.compaction.enabled`, `yunxiaoAgent.compaction.keepTokens`, `yunxiaoAgent.compaction.buffer` configuration groups
- Remove cloud `site` check from `ToolRouter` — all tools are now local; remove `ProtocolError` for cloud-site calls
- Remove cloud `ExecutionSite` type usage from `ToolCall` — `site` field defaults to `'local'`
- Adapt `ChatViewDeps` interface — replace `AIClient` / `SessionManager` / `RollbackManager` with `AgentLoop` / `MessageStore`
- Add model configuration UI in ChatPanel (display current model, API Key status indicator)
- Remove rollback command and rollback UI (cloud-only feature, no local equivalent in this phase)
- Remove manual compress button (compaction is now automatic via `AgentLoop`)
- Update AgentLoop `tool_state_change` event payload to use `call_id` instead of `callId` for frontend compatibility

## Capabilities

### New Capabilities
- `local-agent-session`: Local session management — wraps AgentLoop with sessionId mapping, history loading from MessageStore, and cancel delegation. Replaces cloud-based SessionManager.
- `frontend-local-adaptation`: ChatPanel and extension.ts adaptation for local AgentLoop mode — message routing, event forwarding, UI changes (remove agent selector, add model info, remove rollback/compress buttons).

### Modified Capabilities
- `tool-call-protocol`: Remove cloud SSE tool_call event protocol; tool calls now originate from local LLM response parsing. Remove `tool_result` HTTP endpoint, stream-interrupt continuation, local tool schema reporting at session creation, and duplicate result acknowledgement — all cloud-only concepts.
- `local-tool-registry`: Remove `site` field from `ToolSchema` and `ExecutionSite` type — all tools are local. Remove cloud-site routing logic. Simplify `ToolRouter` to not check `call.site`.

## Impact

- **Deleted files**: `src/aiClient.ts`, `src/protocol/toolCallProtocol.ts`, `src/protocol/sseHandler.ts`, `src/core/sessionManager.ts`, `src/core/runStore.ts`, `src/core/rollbackManager.ts`, and their test files
- **Modified files**: `src/extension.ts` (major rewrite), `src/chatPanel.ts` (major rewrite), `src/core/toolRouter.ts` (remove cloud check), `src/core/types.ts` (remove ExecutionSite), `src/tools/baseTool.ts` (remove cloud references in comments), `src/agent/agentLoop.ts` (fix event payload field names), `package.json` (configuration changes)
- **Test files**: Delete cloud-specific tests (`aiClient.test.ts`, `protocol/`, `core/sessionManager.test.ts`, `core/runStore.test.ts`); update `chatPanel.test.ts` and `extension.test.ts`
- **No new dependencies**: All required modules (AgentLoop, LLMProvider, MessageStore, etc.) already exist from Phases 1-5
- **Breaking**: Users must configure `yunxiaoAgent.model.apiKey` and `yunxiaoAgent.model.model` before use; `serviceBaseUrl` is removed
