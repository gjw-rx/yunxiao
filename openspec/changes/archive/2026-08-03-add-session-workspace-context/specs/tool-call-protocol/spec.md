## MODIFIED Requirements

### Requirement: Local tool schema reporting at session creation
The local plugin SHALL report its local tool schemas and current workspace root to the cloud when creating a session. The session-creation request (`POST /api/agent/invoke/session`) SHALL accept optional `local_tools` (array of tool schemas) and `workspace_root` (the filesystem path of the current workspace root) fields. The cloud SHALL merge `local_tools` into the agent's tool set so the LLM is aware local tools exist, and SHALL associate `workspace_root` with the created session as contextual metadata. The cloud MUST NOT treat `workspace_root` as a cloud-accessible filesystem path. When either optional field is omitted, the cloud SHALL create the session without that context and SHALL NOT return an error.

#### Scenario: Tools and workspace root reported on session creation
- **WHEN** the plugin creates a session with `fs.read_file` registered locally and an open workspace rooted at `D:\\workspace`
- **THEN** it sends `local_tools` containing `fs.read_file` and `workspace_root` equal to `D:\\workspace`, and the cloud associates both with the created session

#### Scenario: Optional context omitted
- **WHEN** a session is created without `local_tools` or `workspace_root` fields
- **THEN** the cloud creates a normal chat-only session and does not error
