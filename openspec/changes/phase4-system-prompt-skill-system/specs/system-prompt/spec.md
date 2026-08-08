## ADDED Requirements

### Requirement: System prompt builder SHALL produce composed prompt

The system SHALL provide a `buildSystemPrompt(context)` function that composes a complete system prompt string from three sections: Agent-level prompt, environment information, and Skill guidance. The function MUST return a non-empty string in all cases.

#### Scenario: Build with all sections present

- **WHEN** `buildSystemPrompt` is called with agentPrompt, workspaceRoot, platform, date, and a non-empty skills array
- **THEN** the returned string SHALL contain the agent prompt text, an environment section with workspaceRoot/platform/date values, and a skill guidance section listing all provided skills

#### Scenario: Build with default agent prompt

- **WHEN** `buildSystemPrompt` is called with agentPrompt set to undefined or empty string
- **THEN** the returned string SHALL use the built-in DEFAULT_AGENT_PROMPT as the agent-level section

#### Scenario: Build with empty skills list

- **WHEN** `buildSystemPrompt` is called with an empty skills array
- **THEN** the returned string SHALL NOT include a skill guidance section

### Requirement: Environment section SHALL include workspace, platform, and date

The system prompt environment section SHALL include the workspace root path, the operating system platform, and the current date. All three values MUST be present in the output.

#### Scenario: Environment values injected

- **WHEN** buildSystemPrompt is called with workspaceRoot="/home/user/project", platform="linux", date="2024-01-15"
- **THEN** the environment section SHALL contain all three values as formatted key-value lines

### Requirement: Skill guidance SHALL list available skills in structured format

When skills are available, the system prompt SHALL include a skill guidance section that instructs the LLM on how to use the skill tool, followed by an XML-structured list of available skills with name and description for each.

#### Scenario: Skills listed in guidance

- **WHEN** buildSystemPrompt is called with skills [{name: "code-review", description: "Review code quality"}, {name: "refactor", description: "Refactoring patterns"}]
- **THEN** the guidance section SHALL contain the instruction text, an `<available_skills>` block, and each skill wrapped in `<skill>` tags with `<name>` and `<description>` child elements

### Requirement: AgentLoop SHALL use buildSystemPrompt instead of hardcoded prompt

The AgentLoop SHALL replace the temporary hardcoded TEMP_SYSTEM_PROMPT with a call to `buildSystemPrompt`, passing the agent prompt from configuration (or default), environment info, and the current Skill list from SkillRegistry.

#### Scenario: AgentLoop builds system prompt per loop iteration

- **WHEN** AgentLoop.run() enters a loop iteration
- **THEN** it SHALL call buildSystemPrompt with the workspace roots, platform, current date, agent prompt config, and skills from SkillRegistry, and use the result as the system message

#### Scenario: AgentLoop works without SkillRegistry

- **WHEN** AgentLoop is constructed with skillRegistry set to null or undefined
- **THEN** it SHALL pass an empty skills array to buildSystemPrompt, and the loop SHALL function normally without skill guidance
