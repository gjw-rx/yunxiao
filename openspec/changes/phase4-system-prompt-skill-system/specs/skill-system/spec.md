## ADDED Requirements

### Requirement: Skill type SHALL define name, description, content, and optional fields

The system SHALL define a `Skill` interface with `name` (string), `description` (string), `content` (string, Markdown body), `slash` (optional boolean), and `sourcePath` (optional string). The system SHALL also define `SkillFrontmatter` with `name`, `description`, and `slash` fields for YAML frontmatter parsing.

#### Scenario: Skill interface is usable

- **WHEN** a Skill object is created with name "test-skill", description "A test", content "Instructions..."
- **THEN** the object SHALL satisfy the Skill interface type check at compile time

### Requirement: Skill loader SHALL scan directory for Markdown files

The system SHALL provide `loadSkillsFromDirectory(dirPath)` that scans a directory for `*.md` files, parses each file's frontmatter and body, and returns a `Skill[]` array. Files without valid frontmatter SHALL be skipped with a warning.

#### Scenario: Load skills from valid directory

- **WHEN** loadSkillsFromDirectory is called with a path containing two valid .md files with frontmatter
- **THEN** it SHALL return an array of two Skill objects, each with name/description from frontmatter and content from the Markdown body

#### Scenario: Skip files without frontmatter

- **WHEN** a .md file does not start with `---` frontmatter delimiter
- **THEN** the loader SHALL skip that file and not include it in the result array

#### Scenario: Skip files with missing required fields

- **WHEN** a .md file's frontmatter is missing the `name` or `description` field
- **THEN** the loader SHALL skip that file

#### Scenario: Non-existent directory returns empty array

- **WHEN** loadSkillsFromDirectory is called with a path that does not exist
- **THEN** it SHALL return an empty array without throwing

### Requirement: Skill frontmatter parser SHALL extract name, description, and slash

The system SHALL parse YAML frontmatter delimited by `---` lines at the start of a Markdown file. The parser SHALL extract `name` (string), `description` (string), and `slash` (boolean, optional) using simple `key: value` line parsing without external YAML libraries.

#### Scenario: Parse standard frontmatter

- **WHEN** parsing a file starting with `---\nname: my-skill\ndescription: A skill\nslash: true\n---\nBody text`
- **THEN** the parser SHALL return frontmatter with name="my-skill", description="A skill", slash=true, and body="Body text"

#### Scenario: Parse without slash field

- **WHEN** parsing frontmatter that only has name and description fields
- **THEN** the slash field SHALL be undefined or false

### Requirement: SkillRegistry SHALL support register, unregister, get, and list

The system SHALL provide a `SkillRegistry` class with methods: `register(skill)` to add a Skill, `unregister(name)` to remove by name, `get(name)` to retrieve by name, `list()` to return all skills, and `listSlashCommands()` to return only skills with `slash: true`.

#### Scenario: Register and retrieve skill

- **WHEN** a skill is registered with name "code-review", then get("code-review") is called
- **THEN** it SHALL return the same Skill object

#### Scenario: Unregister removes skill

- **WHEN** a skill named "code-review" is registered, then unregistered
- **THEN** get("code-review") SHALL return undefined, and list() SHALL not include it

#### Scenario: List slash commands only

- **WHEN** registry has 3 skills, 2 with slash=true
- **THEN** listSlashCommands() SHALL return only those 2 skills

#### Scenario: Duplicate registration overwrites

- **WHEN** a skill named "x" is registered, then another skill with the same name is registered
- **THEN** get("x") SHALL return the most recently registered skill

### Requirement: skill tool SHALL allow LLM to load skill content

The system SHALL provide a `skill` tool (extending BaseTool) registered in ToolRegistry. The tool SHALL accept a `name` parameter, look up the Skill in SkillRegistry, and return the Skill's Markdown content. The tool SHALL have `read` permission (no approval needed) and `local` execution site.

#### Scenario: LLM loads existing skill

- **WHEN** the skill tool is called with name="code-review" and that skill exists in the registry
- **THEN** the tool SHALL return a success result with the skill's content as the result string

#### Scenario: LLM loads non-existent skill

- **WHEN** the skill tool is called with name="nonexistent"
- **THEN** the tool SHALL return an error result with a descriptive message

### Requirement: Plugin activation SHALL initialize SkillRegistry and register skill tool

The system SHALL, during plugin activation, read `yunxiaoAgent.skills.directories` config, scan each directory for Skills, register them in SkillRegistry, and register the skill tool in ToolRegistry.

#### Scenario: Activation with configured skill directory

- **WHEN** the plugin activates and `yunxiaoAgent.skills.directories` contains ".vscode/skills"
- **THEN** the SkillRegistry SHALL contain all valid skills from that directory, and the skill tool SHALL be registered in ToolRegistry

#### Scenario: Activation with no skill directories configured

- **WHEN** the plugin activates and `yunxiaoAgent.skills.directories` is empty or not set
- **THEN** the SkillRegistry SHALL be empty, and the skill tool SHALL still be registered in ToolRegistry

### Requirement: package.json SHALL include skills.directories configuration

The `package.json` contributes.configuration section SHALL include `yunxiaoAgent.skills.directories` as an array of strings with default value `[".vscode/skills"]`.

#### Scenario: Configuration is registered

- **WHEN** the plugin is loaded
- **THEN** VSCode SHALL recognize `yunxiaoAgent.skills.directories` as a valid configuration key with array type
