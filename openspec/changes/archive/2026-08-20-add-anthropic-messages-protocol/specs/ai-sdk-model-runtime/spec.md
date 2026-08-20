## ADDED Requirements

### Requirement: AI SDK model factory supports native Anthropic
The AI SDK model factory SHALL dispatch by normalized provider ID. For `openai` it SHALL preserve the existing OpenAI-compatible model and provider options behavior; for `anthropic` it SHALL create a native Anthropic Messages language model with the configured model, API key, and base URL. Provider-specific options SHALL remain inside the model runtime, and AgentLoop SHALL continue to depend only on `LLMProvider` and `LLMEvent`.

#### Scenario: OpenAI-compatible behavior is unchanged
- **WHEN** an existing model profile uses `provider=openai`
- **THEN** the factory creates the same OpenAI-compatible model and preserves its request, reasoning, usage, cancellation, and tool behavior

#### Scenario: Native Anthropic model is selected
- **WHEN** a model profile uses `provider=anthropic` with the AI SDK runtime
- **THEN** the factory creates the native Anthropic language model and does not route it through OpenAI-compatible Chat Completions

#### Scenario: Unknown provider is rejected
- **WHEN** a model profile contains a provider other than the explicitly supported provider IDs
- **THEN** Provider creation fails with a bounded descriptive error before any network request

### Requirement: Provider options are isolated by provider key
The model runtime SHALL build provider options under the key returned for the selected AI SDK Provider. OpenAI-compatible options MUST NOT be sent to Anthropic, and Anthropic effort or cache options MUST NOT be sent to OpenAI-compatible endpoints.

#### Scenario: Switching providers does not leak options
- **WHEN** two consecutive runs use OpenAI-compatible and Anthropic model profiles respectively
- **THEN** each request contains only the provider options valid for its selected protocol
