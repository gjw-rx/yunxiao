## ADDED Requirements

### Requirement: Agent switching creates an isolated cloud session
When the user selects an Agent different from the one currently bound to the active conversation, the plugin SHALL create a new cloud session for that Agent. It SHALL retain the prior session until creation succeeds, then make the returned session the active conversation and clear the previous session's local orchestration state. Selecting the currently active Agent SHALL NOT create another session.

#### Scenario: Select a different Agent
- **WHEN** a conversation using Agent A is active and the user selects Agent B
- **THEN** the plugin creates a session for Agent B and makes its returned session ID active after the request succeeds

#### Scenario: Re-select the active Agent
- **WHEN** the user selects the Agent already bound to the active conversation
- **THEN** the plugin keeps the active session and does not call the session-creation API

#### Scenario: New session creation fails
- **WHEN** the user selects a different Agent and its session-creation request fails
- **THEN** the plugin preserves the previous active session and reports the error
