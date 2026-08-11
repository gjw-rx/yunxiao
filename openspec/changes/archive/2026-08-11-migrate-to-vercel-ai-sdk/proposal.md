## Why

The extension currently owns OpenAI-compatible request construction, SSE parsing, reasoning extraction, tool-call reconstruction, and provider-specific request options. That protocol layer will continue to grow as additional providers and model capabilities are supported, while its current single-provider implementation creates duplicated maintenance and inconsistent recovery metadata.

Vercel AI SDK provides a mature TypeScript abstraction for model providers, streaming, tool schemas, usage, cancellation, and provider metadata. Adopting it at the protocol boundary lets the project gain that ecosystem without replacing the local Agent runtime and security model that already provide product-specific value.

## What Changes

- Replace the hand-written OpenAI-compatible `fetch` client and SSE stream parser with an AI SDK 6.x-backed model runtime.
- Add an AI SDK provider factory that supports the existing OpenAI-compatible configuration first, then allows explicit native provider packages to be added without changing AgentLoop callers.
- Normalize AI SDK `fullStream` parts into the existing LLM/EventBus contract, including text, reasoning, tool calls, finish reason, usage, provider metadata, and cancellation.
- Adapt registered local `ToolSchema` JSON Schemas for AI SDK tool definitions while keeping `ToolRouter` as the only local tool execution, security-audit, approval, journal, and result-governance boundary.
- Retain the current manual AgentLoop, MessageStore, HistoryLoader, compaction, doom-loop detection, parallel-tool policy, and Webview event protocol; AI SDK `ToolLoopAgent` and AI SDK UI are explicitly out of scope.
- Extend normalized usage handling to preserve cache-token details when a provider supplies them, without regressing existing token accounting.
- Add provider/stream compatibility tests and a temporary configuration-controlled legacy fallback during rollout.

## Capabilities

### New Capabilities

- `ai-sdk-model-runtime`: Provide a Vercel AI SDK 6.x-backed, cancellable, multi-provider model runtime that translates normalized streaming events for the local Agent runtime.
- `ai-sdk-tool-schema-adapter`: Convert registered local JSON Schema tools into AI SDK-compatible definitions without bypassing the local ToolRouter security boundary.

### Modified Capabilities

- `tool-call-protocol`: Source local tool calls from normalized AI SDK stream events instead of OpenAI SSE delta parsing while preserving EventBus ordering and ToolRouter dispatch.
- `token-usage-tracking`: Consume normalized AI SDK usage metadata and retain cache-token details when available while preserving existing accounting and estimation behavior.

## Impact

- Affected code: `src/llm/*`, `src/agent/agentLoop.ts`, `src/agent/toolAdapter.ts`, `src/agent/compaction.ts`, model configuration, and their unit/integration tests.
- Removed implementation: the hand-written OpenAI-compatible request/SSE parser after parity is proven; the legacy implementation remains behind a rollout fallback only until migration acceptance.
- New runtime dependencies: pinned compatible AI SDK 6.x packages, `@ai-sdk/openai-compatible`, and the required schema dependency. Native provider packages are added only when enabled by supported configuration.
- Compatibility: preserve `yunxiaoAgent.model.provider=openai` and existing OpenAI-compatible `baseURL` behavior. The extension continues to support VS Code `^1.99`, so AI SDK 7.x (Node 22+) is out of scope for this change.
- Security and memory: no local tool may execute outside `ToolRouter`; persisted message format and compaction checkpoints remain application-owned.
