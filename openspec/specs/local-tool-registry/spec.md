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

