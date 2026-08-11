# ai-sdk-tool-schema-adapter Specification

## Purpose
TBD - created by archiving change migrate-to-vercel-ai-sdk. Update Purpose after archive.
## Requirements
### Requirement: Registered local tools are exposed through AI SDK-compatible schemas
The runtime SHALL convert every `ToolRegistry` schema into an AI SDK-compatible tool definition using the tool's existing name, description, and JSON Schema parameters. Conversion SHALL preserve the registered schema rather than introduce a second manually maintained parameter schema.

#### Scenario: Registered file tool is exposed
- **WHEN** `fs_read_file` is registered with a description and JSON Schema parameters
- **THEN** the AI SDK model request includes a tool definition with the same name, description, and parameter requirements

#### Scenario: Invalid model arguments are returned to the local validator
- **WHEN** the model returns arguments that violate the registered tool JSON Schema
- **THEN** the local ToolRegistry validation returns the existing structured validation error to the model path

### Requirement: AI SDK tool definitions do not execute local tools directly
The AI SDK tool adapter SHALL NOT register an `execute` callback for local filesystem, code, terminal, Git, web, diff, or skill tools. The AgentLoop SHALL continue to dispatch a normalized `ToolCall` to `ToolRouter.route()` after the stream yields the tool call.

#### Scenario: Read tool is requested
- **WHEN** the model emits a valid `fs_read_file` tool call
- **THEN** the AgentLoop dispatches the call through ToolRouter and does not invoke a tool implementation from an AI SDK callback

#### Scenario: Write tool is requested
- **WHEN** the model emits a valid `fs_write_file` tool call
- **THEN** ToolRouter performs the existing audit and approval flow before any file write occurs

### Requirement: Existing tool execution policy remains authoritative
The AI SDK integration SHALL preserve ToolRouter as the sole local execution boundary for security audit, approval, execution journal, result governance, cancellation status, and read-only parallelism. AI SDK Tool Calling MUST NOT bypass or weaken any of these controls.

#### Scenario: Dangerous terminal command is proposed
- **WHEN** a model requests a terminal tool call classified as dangerous by the local security audit
- **THEN** the audit rejects the call before process creation regardless of the AI SDK tool definition

#### Scenario: Parallel tool calls include a mutating operation
- **WHEN** one model response contains multiple tool calls including a write, execute, or destructive tool
- **THEN** AgentLoop applies its existing local parallelism policy before ToolRouter dispatches the calls

