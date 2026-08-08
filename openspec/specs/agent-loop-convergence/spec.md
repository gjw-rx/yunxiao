## ADDED Requirements

### Requirement: ToolCallTracker SHALL detect consecutive repeated tool calls

The `ToolCallTracker` SHALL maintain a counter of consecutive identical tool calls within a single `AgentLoop.run()` invocation. A tool call is considered identical when both the tool name and a stable serialization of the arguments (JSON.stringify with sorted keys) match the previous call. The counter SHALL reset to zero when a different tool or different arguments are encountered.

#### Scenario: Consecutive identical calls increment counter

- **WHEN** the LLM calls `read_file({path: "/a.ts"})` three times in a row
- **THEN** the ToolCallTracker SHALL report a repeat count of 3

#### Scenario: Different call resets counter

- **WHEN** the LLM calls `read_file({path: "/a.ts"})` then `read_file({path: "/b.ts"})`
- **THEN** the ToolCallTracker SHALL reset the counter to 1 for the second call

#### Scenario: Counter resets after intervention

- **WHEN** the repeat threshold is reached and a guidance message is injected
- **THEN** the ToolCallTracker SHALL reset the counter to zero

### Requirement: AgentLoop SHALL inject guidance message when repeat threshold is reached

When the ToolCallTracker reports a consecutive repeat count reaching the configured threshold (default 3), the AgentLoop SHALL NOT execute the repeated tool call. Instead, it SHALL append a user-role guidance message to the message store informing the LLM that it is repeating the same call and should try a different approach. The loop SHALL then continue to the next iteration.

#### Scenario: Repeat threshold triggers guidance message

- **WHEN** the LLM calls `read_file({path: "/a.ts"})` for the third consecutive time and the threshold is 3
- **THEN** the tool SHALL NOT be executed, and a user message SHALL be appended: "You are repeatedly calling read_file with the same arguments. Please try a different approach or summarize what you have accomplished."

#### Scenario: Different tool call after guidance proceeds normally

- **WHEN** after a guidance message is injected, the LLM calls a different tool or the same tool with different arguments
- **THEN** the AgentLoop SHALL execute the tool call normally

### Requirement: AgentLoop SHALL warn when approaching maxSteps

When the step count reaches 80% of `maxSteps`, the AgentLoop SHALL append a user-role warning message to the message store informing the LLM that it is approaching the step limit. This SHALL NOT disable tools or break the loop.

#### Scenario: Warning at 80% of maxSteps

- **WHEN** maxSteps is 25 and step reaches 20
- **THEN** a user message SHALL be appended: "You are approaching the maximum step limit (25 steps). You have used 20 steps. Please wrap up your work."

#### Scenario: Warning does not break the loop

- **WHEN** the 80% warning is injected
- **THEN** the loop SHALL continue with toolChoice='auto' (not 'none')

### Requirement: ToolResultCache SHALL cache read-only tool results

The `ToolResultCache` SHALL cache results for tools whose `permission` is `'read'` within a single `AgentLoop.run()` invocation. The cache key SHALL be `tool + JSON.stringify(args)` with sorted keys. When a cache hit occurs, the AgentLoop SHALL return the cached result with a `[cached]` prefix in the content, without executing the tool.

#### Scenario: Cache hit returns cached result

- **WHEN** `read_file({path: "/a.ts"})` was executed successfully and the same call is made again in the same run
- **THEN** the cached result SHALL be returned with `[cached]` prefix, and the tool SHALL NOT be executed

#### Scenario: Write tools are not cached

- **WHEN** `write_file` is called twice with the same arguments
- **THEN** the tool SHALL be executed both times (not cached)

#### Scenario: Cache does not persist across runs

- **WHEN** a new `AgentLoop.run()` is started
- **THEN** the ToolResultCache SHALL be empty (no cache from previous runs)

### Requirement: AgentLoop config SHALL support convergence configuration

The `AgentLoopConfig` SHALL include optional fields: `repeatThreshold` (default 3), `cacheReadTools` (default true). These SHALL be configurable via VSCode settings `yunxiaoAgent.agent.repeatThreshold` and `yunxiaoAgent.agent.cacheReadTools`.

#### Scenario: Repeat threshold configurable

- **WHEN** `yunxiaoAgent.agent.repeatThreshold` is set to 2
- **THEN** the AgentLoop SHALL inject guidance message after 2 consecutive identical calls

#### Scenario: Cache can be disabled

- **WHEN** `yunxiaoAgent.agent.cacheReadTools` is set to false
- **THEN** read tool results SHALL NOT be cached and every call SHALL execute the tool
