## MODIFIED Requirements

### Requirement: Tool schema shape
Each `ToolSchema` SHALL declare: `name` (namespaced), `description`, `parameters` (JSON Schema for arguments), and `permissions` (permission level: read/write/execute/destructive). The `site` field SHALL be removed as all tools are local. The schema SHALL be serializable to JSON for conversion to `ToolDefinition` for LLM requests.

#### Scenario: Schema contains permission metadata
- **WHEN** the `fs.read_file` schema is registered
- **THEN** its `permissions` is `read`

#### Scenario: Schema is JSON-serializable
- **WHEN** a schema is serialized via `JSON.stringify`
- **THEN** the output is valid JSON containing name, description, parameters, and permissions

### Requirement: Tool lookup and listing
The registry SHALL provide `lookup(name)` returning the schema and executor for a registered tool, or a not-found error. It SHALL provide `list()` returning the schemas of all registered tools for conversion to `ToolDefinition[]` by `AgentLoop`.

#### Scenario: Lookup unknown tool
- **WHEN** `lookup('fs.nonexistent')` is called
- **THEN** the registry returns a not-found error

#### Scenario: List all tools
- **WHEN** `list()` is called after registering `fs.read_file`
- **THEN** the returned array contains the `fs.read_file` schema

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

## REMOVED Requirements

### Requirement: Local tool schema reporting
**Reason**: No cloud session to report tool schemas to. Tool schemas are used locally by `AgentLoop` to build `ToolDefinition[]` for LLM requests.
**Migration**: `AgentLoop` calls `toolSchemasToDefinitions(toolRegistry.list())` directly. The `localSchemas()` method on `ToolRegistry` is removed.

### Requirement: Execution site routing metadata
**Reason**: All tools are local. There is no cloud-site routing decision. The `ToolRouter` executes all tools locally without checking a `site` field.
**Migration**: `ToolCall.site` field is removed. `ToolRouter.route()` no longer checks `call.site !== 'local'`. The `ProtocolError` for cloud-site calls is removed.
