## MODIFIED Requirements

### Requirement: Extension entry initializes local modules
The `extension.ts` `_activate()` function SHALL initialize a plugin-private `ModelConfig` store, `LLMProvider` (via provider factory), `MessageStore`, `SkillRegistry` (loading the default project `.claude/skills` directory), `ToolRegistry` (registering all tools), `ToolRouter`, and `AgentLoop` (with `AgentLoopConfig` from configuration). It SHALL remove initialization of `AIClient`, cloud `SessionManager`, `RunStore`, `RollbackManager`, and `ToolExecutionJournal` (if no longer needed by the simplified ToolRouter).

#### Scenario: Extension activates with local modules
- **WHEN** the extension is activated
- **THEN** `ModelConfig` reads from plugin-private storage instead of VSCode configuration, `createProvider()` creates an `LLMProvider`, `MessageStore` is instantiated, `SkillRegistry` loads skills, and `AgentLoop` is constructed with the provider, messageStore, toolRouter, toolRegistry, and eventBus

#### Scenario: Extension does not initialize cloud modules
- **WHEN** the extension is activated
- **THEN** no `AIClient`, `RunStore`, `RollbackManager`, or cloud `SessionManager` instances are created
