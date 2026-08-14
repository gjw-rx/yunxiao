# local-tool-registry Specification

## Purpose
TBD - created by archiving change phase1-local-tool-calling. Update Purpose after archive.
## Requirements
### Requirement: Tool registration
The registry SHALL provide `register(tool)` for static local tools and an owner-scoped dynamic registration operation for MCP adapters. Every tool SHALL be keyed by a unique model-visible name. Owner-scoped replacement SHALL validate the complete candidate set before atomically replacing that owner's previous tools. Registering a duplicate name across static or dynamic owners SHALL raise a clear error rather than silently overwriting any existing tool.

#### Scenario: Register a static local tool
- **WHEN** the registry registers a local BaseTool named `fs_read_file`
- **THEN** lookup returns that tool

#### Scenario: Register an MCP owner snapshot
- **WHEN** owner `mcp:codegraph` registers `mcp__codegraph__codegraph_explore`
- **THEN** lookup returns the MCP adapter and the owner can later replace or remove its complete set

#### Scenario: Duplicate registration rejected across owners
- **WHEN** a dynamic owner attempts to register a name held by another owner
- **THEN** the registry raises an error and all existing tools remain unchanged

#### Scenario: Invalid replacement is atomic
- **WHEN** one candidate in an owner replacement conflicts
- **THEN** none of the candidates is published and the prior owner snapshot remains

### Requirement: Tool lookup and listing
The registry SHALL provide `lookup(name)` returning the registered BaseTool or a not-found error. It SHALL provide `list()` returning a consistent snapshot of all static and currently published MCP schemas for AgentLoop conversion. It SHALL remove all tools for one MCP owner without affecting other owners.

#### Scenario: Lookup unknown tool
- **WHEN** lookup is called for an unknown exposed name
- **THEN** the registry returns a not-found error

#### Scenario: List static and MCP tools
- **WHEN** a local file tool and a ready remote MCP tool are registered
- **THEN** one list snapshot contains both exactly once

#### Scenario: Remove stopped Server owner
- **WHEN** Manager unregisters an MCP Server owner
- **THEN** only that Server tools disappear

### Requirement: Tool schema shape
Each registered schema SHALL declare name, description, JSON Schema parameters and permissions read/write/execute/destructive. Registry owner/source metadata SHALL remain outside model-controlled serialized arguments. Static tools and MCP adapters SHALL share the same schema contract so Function Calling conversion and ToolRouter policy require no source-specific branch.

#### Scenario: MCP schema serializable
- **WHEN** an MCP adapter is registered
- **THEN** its schema is JSON-serializable and includes mapped permission metadata

#### Scenario: Source cannot be spoofed
- **WHEN** the model includes owner or Transport fields in arguments
- **THEN** routing still uses trusted registry metadata

### Requirement: Approval gating for write/destructive tools
The router SHALL consult the `ApprovalGateway` before executing any tool whose `permissions` is `write`, `execute`, or `destructive`. When approval is denied, the router SHALL return a `ToolResult` with `status: 'cancelled'` and SHALL NOT invoke the tool's `execute`. Tools with `permissions: read` SHALL execute without consultation. The router SHALL base this decision on the tool's declared `permissions`, not on any inbound flag (defense in depth: local is the security boundary). The router SHALL NOT check a `site` field on the `ToolCall` as all tools are local.

#### Scenario: Write tool gated and approved
- **WHEN** the router routes a `tool_call` for `fs.write_file` (permission `write`) and the user approves
- **THEN** the router invokes `execute` after approval

#### Scenario: Destructive tool gated and denied
- **WHEN** the router routes a `tool_call` for `fs.delete_file` (permission `destructive`) and the user denies
- **THEN** the router returns `{ status: 'cancelled', error: '用户拒绝执行' }` and `execute` is not called

#### Scenario: Read tool not gated
- **WHEN** the router routes a `tool_call` for `fs.read_file` (permission `read`)
- **THEN** the gateway is not consulted and `execute` runs immediately
