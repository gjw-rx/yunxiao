## ADDED Requirements

### Requirement: AI SDK runtime compatibility
The extension SHALL use a pinned Vercel AI SDK 6.x dependency set whose runtime engine supports the Node version supplied by VS Code `^1.99`. The extension MUST NOT resolve AI SDK dependencies through `latest` or an unconstrained cross-major range. The runtime dependency set SHALL be validated by the extension compile pipeline and an Extension Host smoke test.

#### Scenario: Compatible dependency set is installed
- **WHEN** the extension dependencies are installed for a VS Code 1.99 Extension Host
- **THEN** the AI SDK model runtime loads without a Node engine incompatibility error

#### Scenario: Unsupported major is selected
- **WHEN** a dependency update selects an AI SDK major requiring a Node version unavailable to the declared minimum VS Code version
- **THEN** dependency validation fails before the extension package is published

### Requirement: Existing OpenAI-compatible configuration remains supported
The AI SDK model factory SHALL accept the existing `yunxiaoAgent.model.provider=openai`, `model`, `apiKey`, and `baseURL` configuration without changing its meaning. It SHALL create an OpenAI-compatible language model using the configured endpoint and SHALL map existing generation settings to their AI SDK equivalents. Provider-specific options SHALL remain outside AgentLoop and SHALL be applied only by the model runtime.

#### Scenario: Existing custom base URL is used
- **WHEN** the user configures `provider=openai`, a custom `baseURL`, API key, and model name
- **THEN** the AI SDK runtime sends the model request to that base URL with the configured credentials and model name

#### Scenario: AgentLoop is provider agnostic
- **WHEN** a provider-specific generation option is required
- **THEN** the option is resolved by the model runtime and no provider-specific branch is added to AgentLoop

### Requirement: AI SDK fullStream is normalized to the local LLM event contract
The model runtime SHALL translate a single AI SDK `fullStream` into the existing `LLMEvent` contract. Text deltas SHALL become `textDelta`, reasoning deltas SHALL become `reasoningDelta`, complete tool calls SHALL become `toolCall`, terminal completion SHALL become `finish`, and terminal failures SHALL become `error`. Each complete tool call SHALL preserve the provider call ID, tool name, and JSON-serializable arguments.

#### Scenario: Text and reasoning are streamed
- **WHEN** AI SDK emits text and reasoning delta parts
- **THEN** the local AgentLoop receives corresponding `textDelta` and `reasoningDelta` events in stream order

#### Scenario: A tool call is completed
- **WHEN** AI SDK emits a complete `tool-call` part with an ID, tool name, and input object
- **THEN** the runtime emits one `toolCall` event using the same ID and name and JSON-serialized input

#### Scenario: A provider reports a terminal error
- **WHEN** AI SDK emits an error part or the stream fails
- **THEN** the runtime emits one local `error` event with a user-safe error message and does not emit a successful finish event

### Requirement: Usage and completion are emitted once per model invocation
For each `LLMProvider.chatCompletion` invocation, the AI SDK runtime SHALL emit at most one authoritative usage event and exactly one terminal `finish` or `error` event unless the caller aborts. The runtime SHALL use final stream usage as the authoritative total and SHALL NOT double count intermediate step usage.

#### Scenario: Final usage is present
- **WHEN** an AI SDK stream produces intermediate step events and final total usage
- **THEN** the local event stream contains one usage event derived from the final total usage before its finish event

#### Scenario: Usage is absent
- **WHEN** the provider completes without usage metadata
- **THEN** the runtime completes normally without inventing provider usage and the existing token estimator remains eligible to supply estimated values

### Requirement: Cancellation reaches the provider request
The model runtime SHALL pass the AgentLoop abort signal to AI SDK. When the user cancels a run, the runtime SHALL stop consuming the stream, prevent subsequent tool dispatch for that invocation, and release the underlying provider request.

#### Scenario: User cancels during text streaming
- **WHEN** the AgentLoop abort signal is triggered while text is streaming
- **THEN** no additional text, tool call, or tool result is dispatched for that invocation after cancellation

### Requirement: Legacy runtime fallback is temporary and controlled
The extension SHALL provide a migration-period runtime selector that defaults to the AI SDK runtime and can explicitly select the legacy provider/parser implementation for rollback. The selector SHALL not alter persisted message, tool, approval, or Webview event formats.

#### Scenario: AI SDK is the default runtime
- **WHEN** the runtime selector is not configured
- **THEN** new model invocations use the AI SDK runtime

#### Scenario: Legacy fallback is selected
- **WHEN** the migration runtime selector is set to `legacy`
- **THEN** model invocations use the legacy provider/parser while all other AgentLoop, tool, memory, and UI behavior remains unchanged
