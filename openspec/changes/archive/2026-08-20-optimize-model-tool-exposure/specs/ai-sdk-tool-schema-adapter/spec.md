## MODIFIED Requirements

### Requirement: Registered local tools are exposed through AI SDK-compatible schemas

The runtime SHALL convert the current run's 13 local responsibility-tool schemas — `bash`, `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `task`, `webfetch`, `websearch`, `todowrite`, `skill`, and `question` — into AI SDK-compatible tool definitions using their model-visible names, descriptions, and JSON Schema parameters. The runtime SHALL continue converting every tool schema from each enabled and ready MCP server in the current run's MCP snapshot into an AI SDK-compatible definition using the registered MCP name, description, and input schema. Conversion SHALL preserve the source snapshot schema rather than introduce a second manually maintained parameter schema. Other local Registry entries SHALL remain executable implementation details and SHALL NOT become independent local AI SDK definitions.

#### Scenario: Responsibility tool is exposed
- **WHEN** a normal-mode run is created
- **THEN** the model request contains an AI SDK tool named `read`
- **AND** its file/directory parameters match the responsibility facade schema

#### Scenario: Ready MCP tool remains directly exposed
- **WHEN** an enabled MCP server is ready and publishes a function tool
- **THEN** the model request contains an independent AI SDK tool using the registered MCP tool name
- **AND** its description and input schema match the MCP snapshot

#### Scenario: Hidden local implementation is not independently exposed
- **WHEN** the Registry contains `fs_read_file`, `git_status`, or `code_find_references`
- **THEN** the model request does not contain independent AI SDK definitions for those local names
- **AND** the corresponding capability is available only through its responsibility facade or approved execution path

#### Scenario: Invalid MCP arguments fail before remote execution
- **WHEN** the model invokes a directly exposed MCP tool with arguments that violate its registered JSON Schema
- **THEN** the underlying ToolRouter validation returns a structured failure
- **AND** no remote MCP execution occurs

