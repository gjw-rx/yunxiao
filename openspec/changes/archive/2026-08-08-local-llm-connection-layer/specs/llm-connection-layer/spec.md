## ADDED Requirements

### Requirement: LLM message types
The system SHALL define `LLMMessage` as a discriminated union covering `system`, `user`, `assistant`, and `tool` roles. Each message SHALL carry a `role` field and a `content` field. The `assistant` message SHALL optionally include `toolCalls` (an array of `{ id, name, arguments }`). The `tool` message SHALL carry `toolCallId` and `content`.

#### Scenario: System message shape
- **WHEN** a `LLMMessage` with `role: "system"` is constructed
- **THEN** it contains a `content: string` field and no `toolCalls` or `toolCallId`

#### Scenario: Assistant message with tool calls
- **WHEN** a `LLMMessage` with `role: "assistant"` includes tool calls
- **THEN** it has a `toolCalls` array where each entry has `id: string`, `name: string`, and `arguments: string`

#### Scenario: Tool result message
- **WHEN** a `LLMMessage` with `role: "tool"` is constructed
- **THEN** it carries `toolCallId: string` and `content: string`

### Requirement: LLM request interface
The system SHALL define `LLMRequest` containing: `model`, `messages: LLMMessage[]`, optional `tools: ToolDefinition[]`, optional `toolChoice`, optional `temperature`, optional `maxTokens`, and `stream: true` (always enforced).

#### Scenario: Minimal request
- **WHEN** an `LLMRequest` is constructed with only `model` and `messages`
- **THEN** `stream` is `true` and `tools`/`toolChoice`/`temperature`/`maxTokens` are undefined

#### Scenario: Request with tools
- **WHEN** an `LLMRequest` includes `tools` and `toolChoice: "auto"`
- **THEN** the `tools` array contains `ToolDefinition` entries and `toolChoice` is `"auto"`

### Requirement: LLM streaming event types
The system SHALL define `LLMEvent` as a discriminated union with five variants: `textDelta` (carrying `text`), `toolCall` (carrying `id`, `name`, `arguments`), `usage` (carrying `inputTokens` and `outputTokens`), `finish` (carrying `reason: "stop" | "tool_use" | "length"`), and `error` (carrying `error: string`).

#### Scenario: Text delta event
- **WHEN** the LLM produces a text content chunk
- **THEN** a `LLMEvent` with `type: "textDelta"` and `text: string` is yielded

#### Scenario: Tool call event
- **WHEN** the LLM produces a complete tool call (after merging incremental fragments)
- **THEN** a `LLMEvent` with `type: "toolCall"`, `id`, `name`, and `arguments` is yielded

#### Scenario: Finish event
- **WHEN** the LLM stream ends with a `finish_reason`
- **THEN** a `LLMEvent` with `type: "finish"` and the corresponding `reason` is yielded

#### Scenario: Error event
- **WHEN** the LLM request or stream encounters an error
- **THEN** a `LLMEvent` with `type: "error"` and `error: string` is yielded

### Requirement: Tool definition format
The system SHALL define `ToolDefinition` containing `name: string`, `description: string`, and `parameters: Record<string, unknown>` (JSON Schema). The format SHALL be compatible with OpenAI function calling.

#### Scenario: Tool definition is JSON-serializable
- **WHEN** a `ToolDefinition` is serialized via `JSON.stringify`
- **THEN** the output is valid JSON containing `name`, `description`, and `parameters`

### Requirement: LLM provider interface
The system SHALL define `LLMProvider` interface with a single method `chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent>`. The method SHALL yield `LLMEvent` items as they arrive from the LLM, supporting streaming consumption.

#### Scenario: Provider returns async generator
- **WHEN** `provider.chatCompletion(request)` is called
- **THEN** the return value is an `AsyncGenerator<LLMEvent>` that can be iterated with `for await`

### Requirement: OpenAI-compatible provider implementation
The system SHALL implement `OpenAIProvider` class that implements `LLMProvider`. It SHALL construct an OpenAI `/v1/chat/completions` request body from `LLMRequest`, including `messages` conversion, `tools` conversion to OpenAI function format, and `stream: true`. It SHALL set `Authorization: Bearer <apiKey>` and `Content-Type: application/json` headers. It SHALL use native `fetch` to send the request and delegate response parsing to the stream parser.

#### Scenario: Request body construction
- **WHEN** `chatCompletion` is called with a request containing `model`, `messages`, and `tools`
- **THEN** the fetch request body includes `model`, `messages` (in OpenAI format), `tools` (as `{ type: "function", function: { name, description, parameters } }`), and `stream: true`

#### Scenario: Authorization header
- **WHEN** the provider sends a request with `apiKey: "sk-xxx"`
- **THEN** the `Authorization` header is set to `Bearer sk-xxx`

#### Scenario: Non-OK HTTP response
- **WHEN** the fetch response has a status code outside 200-299
- **THEN** the provider yields a single `LLMEvent` with `type: "error"` containing the status code and response body

#### Scenario: Network error
- **WHEN** the fetch call throws a network error
- **THEN** the provider yields a single `LLMEvent` with `type: "error"` containing the error message

### Requirement: SSE stream parser
The system SHALL implement a stream parser that accepts a `ReadableStream<Uint8Array>` (from fetch response body) and yields `LLMEvent` items. The parser SHALL: split the stream by newlines, extract lines prefixed with `data: `, skip empty lines and `[DONE]` markers, parse each JSON chunk, extract `choices[0].delta.content` as `textDelta` events, accumulate `choices[0].delta.tool_calls` fragments by `index` into complete `toolCall` events, map `choices[0].finish_reason` to `finish` events, and extract `usage` as `usage` events.

#### Scenario: Parse text content delta
- **WHEN** a chunk contains `{ "choices": [{ "delta": { "content": "hello" } }] }`
- **THEN** the parser yields `{ type: "textDelta", text: "hello" }`

#### Scenario: Parse tool call fragments
- **WHEN** two consecutive chunks contain `delta.tool_calls` with the same `index` but partial `function.name` and `function.arguments`
- **THEN** the parser yields a single `toolCall` event with the merged `name` and `arguments` when the tool call is complete

#### Scenario: Parse finish reason
- **WHEN** a chunk contains `{ "choices": [{ "finish_reason": "stop" }] }`
- **THEN** the parser yields `{ type: "finish", reason: "stop" }`

#### Scenario: Handle DONE marker
- **WHEN** the stream contains a `data: [DONE]` line
- **THEN** the parser stops iterating without yielding an event for that line

#### Scenario: Parse usage
- **WHEN** a chunk contains `{ "usage": { "prompt_tokens": 100, "completion_tokens": 50 } }`
- **THEN** the parser yields `{ type: "usage", inputTokens: 100, outputTokens: 50 }`

### Requirement: Provider factory
The system SHALL implement a `createProvider(config: ModelConfig): LLMProvider` factory function. When `config.provider` is `"openai"`, it SHALL return an `OpenAIProvider` instance. For unknown provider IDs, it SHALL throw an error with a descriptive message.

#### Scenario: Create OpenAI provider
- **WHEN** `createProvider` is called with `config.provider: "openai"`
- **THEN** an `OpenAIProvider` instance is returned

#### Scenario: Unknown provider
- **WHEN** `createProvider` is called with `config.provider: "unknown"`
- **THEN** an error is thrown with a message indicating the provider is not supported
