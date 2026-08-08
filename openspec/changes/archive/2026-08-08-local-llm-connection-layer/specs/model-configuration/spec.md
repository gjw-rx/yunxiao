## ADDED Requirements

### Requirement: Model configuration schema
The system SHALL define `ModelConfig` containing: `provider: string` (default `"openai"`), `model: string`, `apiKey: string`, `baseURL: string`, `temperature: number` (default `0.7`), `maxTokens: number` (default `4096`).

#### Scenario: Default configuration
- **WHEN** no model configuration is set by the user
- **THEN** `provider` defaults to `"openai"`, `temperature` defaults to `0.7`, `maxTokens` defaults to `4096`

#### Scenario: Custom configuration
- **WHEN** the user sets `yunxiaoAgent.model.model` to `"deepseek-chat"` and `yunxiaoAgent.model.baseURL` to `"https://api.deepseek.com/v1"`
- **THEN** `ModelConfig.model` is `"deepseek-chat"` and `ModelConfig.baseURL` is `"https://api.deepseek.com/v1"`

### Requirement: Read model configuration from VSCode
The system SHALL provide a function `getModelConfig(): ModelConfig` that reads from `vscode.workspace.getConfiguration('yunxiaoAgent.model')`. It SHALL map each VSCode configuration key to the corresponding `ModelConfig` field with type-safe defaults.

#### Scenario: Read all fields
- **WHEN** `getModelConfig()` is called and the user has configured `provider`, `model`, `apiKey`, `baseURL`, `temperature`, and `maxTokens`
- **THEN** the returned `ModelConfig` contains all configured values

#### Scenario: Missing optional fields use defaults
- **WHEN** `getModelConfig()` is called and the user has only set `model` and `apiKey`
- **THEN** `provider` defaults to `"openai"`, `temperature` defaults to `0.7`, `maxTokens` defaults to `4096`

### Requirement: Configuration change listener
The system SHALL provide a function `onModelConfigChange(callback: (config: ModelConfig) => void): Disposable` that registers a callback invoked when any `yunxiaoAgent.model.*` configuration changes. The callback SHALL receive the updated `ModelConfig`.

#### Scenario: Configuration change triggers callback
- **WHEN** the user changes `yunxiaoAgent.model.model` from `"gpt-4o"` to `"gpt-4o-mini"`
- **THEN** the registered callback is invoked with a `ModelConfig` where `model` is `"gpt-4o-mini"`

#### Scenario: Dispose listener
- **WHEN** the returned `Disposable` is disposed
- **THEN** the callback is no longer invoked on configuration changes

### Requirement: Register model configuration in package.json
The system SHALL register the following configuration properties in `package.json` under `contributes.configuration.properties`: `yunxiaoAgent.model.provider` (string, default `"openai"`), `yunxiaoAgent.model.model` (string, default `""`), `yunxiaoAgent.model.apiKey` (string, default `""`), `yunxiaoAgent.model.baseURL` (string, default `"https://api.openai.com/v1"`), `yunxiaoAgent.model.temperature` (number, default `0.7`), `yunxiaoAgent.model.maxTokens` (number, default `4096`). All properties SHALL have `scope: "window"`.

#### Scenario: Configuration properties registered
- **WHEN** the extension activates and VSCode reads `package.json`
- **THEN** all six `yunxiaoAgent.model.*` properties are available in the VSCode Settings UI

#### Scenario: API key field is password-type
- **WHEN** the user opens the Settings UI for `yunxiaoAgent.model.apiKey`
- **THEN** the field accepts a string input (note: VSCode does not natively support password-type for configuration; the value is stored as a plain string)
