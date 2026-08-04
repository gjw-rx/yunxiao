# local-tool-registry Specification

## Purpose
TBD - created by archiving change phase1-local-tool-calling. Update Purpose after archive.
## Requirements
### Requirement: Tool registration
The registry SHALL provide `register(schema: ToolSchema, executor: ToolExecutor)` that stores a tool keyed by its unique name. A tool name MUST follow the namespaced convention (`<namespace>.<verb>`, e.g. `fs.read_file`) to avoid collisions with cloud tools. Registering a duplicate name SHALL raise a clear error rather than silently overwriting.

#### Scenario: Register a new tool
- **WHEN** the registry registers a tool named `fs.read_file` with a valid schema and executor
- **THEN** `lookup('fs.read_file')` returns that schema and executor

#### Scenario: Duplicate registration rejected
- **WHEN** the registry already contains `fs.read_file` and a second registration with the same name is attempted
- **THEN** the registry raises an error and the original registration is unchanged

### Requirement: Tool lookup and listing
The registry SHALL provide `lookup(name)` returning the schema and executor for a registered tool, or a not-found error. It SHALL provide `list()` returning the schemas of all registered tools for reporting to the cloud.

#### Scenario: Lookup unknown tool
- **WHEN** `lookup('fs.nonexistent')` is called
- **THEN** the registry returns a not-found error

#### Scenario: List all tools
- **WHEN** `list()` is called after registering `fs.read_file`
- **THEN** the returned array contains the `fs.read_file` schema

### Requirement: Tool schema shape
Each `ToolSchema` SHALL declare: `name` (namespaced), `description`, `parameters` (JSON Schema for arguments), `permissions` (permission level: read/write/execute/destructive), and `site` (`'local' | 'cloud'`). The schema SHALL be serializable to JSON for upload to the cloud during session creation.

#### Scenario: Schema contains permission metadata
- **WHEN** the `fs.read_file` schema is registered
- **THEN** its `permissions` is `read` and its `site` is `local`

#### Scenario: Schema is JSON-serializable
- **WHEN** a schema is serialized via `JSON.stringify`
- **THEN** the output is valid JSON containing name, description, parameters, permissions, and site

### Requirement: Local tool schema reporting
The registry SHALL expose a method that produces the array of local tool schemas to be sent to the cloud at session creation (the `local_tools` field). Only tools whose `site` is `local` SHALL be included.

#### Scenario: Reporting excludes cloud tools
- **WHEN** the registry contains one `local` tool and one `cloud` tool and the report is generated
- **THEN** the report contains only the local tool's schema

### Requirement: Execution site routing metadata
Each registered tool SHALL carry its `site` so the router can decide, on receiving a `tool_call`, whether to execute locally or defer to the cloud. In Phase 1 the local router SHALL only handle `site: local` calls; a `tool_call` for a cloud-site tool SHALL be ignored locally (the cloud executes it and emits `tool_start`/`tool_end` as today).

#### Scenario: Local tool call routed to local executor
- **WHEN** a `tool_call` for `fs.read_file` (site local) arrives
- **THEN** the router dispatches it to the registered local executor

#### Scenario: Cloud tool call not executed locally
- **WHEN** a `tool_call` for a cloud-site tool arrives
- **THEN** the local router does not execute it and leaves cloud-side handling intact

### Requirement: Approval gating for write/destructive tools
The router SHALL consult the `ApprovalGateway` before executing any tool whose `permissions` is `write`, `execute`, or `destructive`. When approval is denied, the router SHALL return a `ToolResult` with `status: 'cancelled'` and SHALL NOT invoke the tool's `execute`. Tools with `permissions: read` SHALL execute without consultation. The router SHALL base this decision on the tool's declared `permissions`, not on the inbound `tool_call.require_approval` flag (defense in depth: local is the security boundary). For a permitted non-read tool, the router SHALL consult the local execution journal before invoking `execute`; a terminal receipt MUST be reused and a non-terminal receipt MUST block execution with an unknown non-retryable result.

#### Scenario: Write tool gated and approved
- **WHEN** the router routes a `tool_call` for `fs.write_file` (permission `write`) and the user approves
- **THEN** the router records or resolves its execution receipt before it invokes `execute`

#### Scenario: Destructive tool gated and denied
- **WHEN** the router routes a `tool_call` for `fs.delete_file` (permission `destructive`) and the user denies
- **THEN** the router returns `{ status: 'cancelled', error: '用户拒绝执行' }` and `execute` is not called

#### Scenario: Read tool not gated
- **WHEN** the router routes a `tool_call` for `fs.read_file` (permission `read`)
- **THEN** the gateway is not consulted and `execute` runs immediately

#### Scenario: Local gates regardless of cloud flag
- **WHEN** a `tool_call` for a `write` tool arrives with `require_approval: false`
- **THEN** the router still consults the gateway because the tool's declared permission is `write`

#### Scenario: Interrupted prior execution is retried
- **WHEN** the router receives a permitted non-read call with an existing non-terminal execution receipt
- **THEN** the router returns an unknown non-retryable result and does not invoke `execute`

