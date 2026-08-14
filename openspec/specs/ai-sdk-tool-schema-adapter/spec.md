# ai-sdk-tool-schema-adapter Specification

## Purpose
TBD - created by archiving change migrate-to-vercel-ai-sdk. Update Purpose after archive.
## Requirements
### Requirement: Registered local tools are exposed through AI SDK-compatible schemas
The runtime SHALL convert every schema in the current ToolRegistry snapshot, including static local tools and dynamically published MCP adapters, into an AI SDK-compatible tool definition using the registered model-visible name, description, and JSON Schema parameters. Conversion SHALL preserve the registered schema rather than introduce a second manually maintained parameter schema.

#### Scenario: Registered file tool is exposed
- **WHEN** `fs_read_file` is registered
- **THEN** the model request contains the same name, description and parameters

#### Scenario: Ready MCP tool is exposed
- **WHEN** an enabled STDIO or remote MCP Server is ready and published
- **THEN** the model request contains its namespaced Function Calling definition

#### Scenario: Invalid MCP arguments are locally rejected
- **WHEN** model arguments violate the discovered inputSchema
- **THEN** ToolRegistry returns the existing structured validation error before MCP invocation

### Requirement: AI SDK tool definitions do not execute local tools directly
The AI SDK tool adapter SHALL NOT register an execute callback for static local tools or MCP adapters. AgentLoop SHALL dispatch every normalized ToolCall to ToolRouter after the stream yields it, and MCP protocol invocation SHALL occur only from McpToolAdapter after routing succeeds.

#### Scenario: Local tool requested
- **WHEN** the model requests `fs_read_file`
- **THEN** AgentLoop dispatches through ToolRouter rather than AI SDK execute

#### Scenario: Remote MCP tool requested
- **WHEN** the model requests a Streamable HTTP MCP tool
- **THEN** AgentLoop dispatches through ToolRouter and AI SDK never accesses its URL or Client

### Requirement: Existing tool execution policy remains authoritative
The AI SDK integration SHALL preserve ToolRouter as the sole execution boundary for static and MCP tools, including audit, approval, execution journal where applicable, result governance, cancellation and parallelism. A tool's STDIO or remote source MUST NOT bypass or weaken any control.

#### Scenario: Unclassified remote tool proposed
- **WHEN** the model requests a remote MCP tool mapped to execute
- **THEN** ToolRouter requests approval before network tools/call

#### Scenario: Mixed parallel calls
- **WHEN** one response includes local, read-only MCP and execute MCP calls
- **THEN** AgentLoop applies the existing parallelism policy before dispatch
