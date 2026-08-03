# git-tools Specification

## ADDED Requirements

### Requirement: Git status query
The system SHALL provide a `git.status` tool (permission `read`, site `local`) that returns the working tree status via `simple-git`: current branch, tracking branch, staged files, unstaged changes, and untracked files. Files SHALL be returned as workspace-relative paths.

#### Scenario: Clean working tree
- **WHEN** `git.status` is called on a repository with no changes
- **THEN** the tool returns `{ status: "success", result: "{ currentBranch: \"main\", staged: [], unstaged: [], untracked: [] }" }`

#### Scenario: Mixed changes
- **WHEN** `git.status` is called on a repository with staged, unstaged, and untracked files
- **THEN** the result lists each file with its state (staged-modified, unstaged-modified, untracked) as workspace-relative paths

#### Scenario: Not a git repository
- **WHEN** `git.status` is called in a workspace that is not a git repository
- **THEN** the tool returns `{ status: "error", error: "当前工作区不是 git 仓库" }`

#### Scenario: File list truncated
- **WHEN** `git.status` returns more than 200 changed files
- **THEN** the result is truncated to 200 files with `{ truncated: true, total: N }`

### Requirement: Git diff query
The system SHALL provide a `git.diff` tool (permission `read`, site `local`) that returns a structured diff of changes. It SHALL support a `mode` parameter: `unstaged` (default, working tree vs index), `staged` (index vs HEAD), or `ref` (compare against a git ref via `base` parameter). The diff SHALL be grouped by file with hunks.

#### Scenario: Unstaged diff
- **WHEN** `git.diff` is called with `{ mode: "unstaged" }`
- **THEN** the tool returns the diff of unstaged changes grouped by file

#### Scenario: Staged diff
- **WHEN** `git.diff` is called with `{ mode: "staged" }`
- **THEN** the tool returns the diff of staged (cached) changes

#### Scenario: Diff against a ref
- **WHEN** `git.diff` is called with `{ mode: "ref", base: "main" }`
- **THEN** the tool returns the diff between the current HEAD and the `main` branch

#### Scenario: Diff output truncated
- **WHEN** the diff output exceeds 10000 characters
- **THEN** the result is truncated with a truncation marker, preserving the first hunks of each file

### Requirement: Git commit
The system SHALL provide a `git.commit` tool (permission `write`, site `local`) that commits staged changes with a user-provided message. The tool SHALL route through the standard router-level `ApprovalGateway` (not `handlesOwnApproval`). The tool SHALL reject messages containing `--no-verify` or `--amend` flags and SHALL require a non-empty message.

#### Scenario: Commit staged changes
- **WHEN** `git.commit` is called with `{ message: "fix: correct off-by-one error" }` and the user approves
- **THEN** the tool commits the staged changes and returns `{ status: "success", result: "已提交: <sha>", metadata: { sha: "<short-sha>" } }`

#### Scenario: Empty message rejected
- **WHEN** `git.commit` is called with `{ message: "" }`
- **THEN** validation throws `ToolValidationError` because message must be non-empty

#### Scenario: No-verify flag rejected
- **WHEN** `git.commit` is called with `{ message: "test --no-verify" }`
- **THEN** validation throws `ToolValidationError` because `--no-verify` is forbidden

#### Scenario: Nothing staged to commit
- **WHEN** `git.commit` is called but no changes are staged
- **THEN** the tool returns `{ status: "error", error: "没有已暂存的更改可提交" }`

#### Scenario: Commit denied by user
- **WHEN** `git.commit` is called and the user denies approval at the router level
- **THEN** the tool returns `{ status: "cancelled", error: "用户拒绝执行" }` and no commit is created

### Requirement: Git branch management
The system SHALL provide a `git.branch` tool (permission `write`, site `local`) supporting `action` parameter: `list` (default, list local and remote branches with current marked), `create` (create a new branch via `name`), `checkout` (switch to an existing branch via `name`). The tool SHALL route through the standard router-level `ApprovalGateway`.

#### Scenario: List branches
- **WHEN** `git.branch` is called with `{ action: "list" }` and the user approves
- **THEN** the tool returns all local and remote branches with the current branch marked

#### Scenario: Create a branch
- **WHEN** `git.branch` is called with `{ action: "create", name: "feature/login" }` and the user approves
- **THEN** the tool creates the branch and returns `{ status: "success", result: "已创建分支: feature/login" }`

#### Scenario: Checkout a branch
- **WHEN** `git.branch` is called with `{ action: "checkout", name: "develop" }` and the user approves
- **THEN** the tool switches to the branch and returns `{ status: "success", result: "已切换到分支: develop" }`

#### Scenario: Create branch without name
- **WHEN** `git.branch` is called with `{ action: "create" }` without `name`
- **THEN** validation throws `ToolValidationError` because `name` is required for create/checkout

#### Scenario: Checkout with uncommitted changes blocked
- **WHEN** `git.branch` is called with `{ action: "checkout", name: "develop" }` but the working tree has uncommitted changes that would be overwritten
- **THEN** the tool returns `{ status: "error", error: "切换失败：工作区有未提交更改可能被覆盖" }`

### Requirement: Git stash operations
The system SHALL provide a `git.stash` tool (permission `write`, site `local`) supporting `action` parameter: `push` (default, stash current changes with optional `message`), `pop` (restore and drop the top stash), `list` (list stash entries). The tool SHALL route through the standard router-level `ApprovalGateway`.

#### Scenario: Push stash
- **WHEN** `git.stash` is called with `{ action: "push", message: "wip: before refactor" }` and the user approves
- **THEN** the tool stashes current changes and returns `{ status: "success", result: "已 stash 当前更改" }`

#### Scenario: Pop stash
- **WHEN** `git.stash` is called with `{ action: "pop" }` and the user approves
- **THEN** the tool restores the top stash entry and returns success

#### Scenario: List stash
- **WHEN** `git.stash` is called with `{ action: "list" }` and the user approves
- **THEN** the tool returns the stash entries list (empty array if none)

#### Scenario: Pop with empty stash
- **WHEN** `git.stash` is called with `{ action: "pop" }` but there are no stash entries
- **THEN** the tool returns `{ status: "error", error: "没有 stash 条目可恢复" }`

### Requirement: Git client based on simple-git
All `git.*` tools SHALL use the `simple-git` npm package as the underlying Git client, constructed with the workspace root as the repo path. The tools SHALL NOT use the `vscode.git` extension internal API.

#### Scenario: simple-git constructed with workspace root
- **WHEN** the git tools are assembled at extension activation
- **THEN** a `simpleGit(workspaceRoot)` instance is created and shared across all `git.*` tools

### Requirement: Git repo path resolution
The `git.*` tools SHALL resolve the repository root from `ToolContext.workspaceRoots[0]`. If the workspace is not a git repository, the tools SHALL return an error (not throw).

#### Scenario: Non-git workspace returns error
- **WHEN** any `git.*` tool is called in a workspace that is not a git repository
- **THEN** the tool returns `{ status: "error", error: "当前工作区不是 git 仓库" }` without throwing

### Requirement: Output as JSON strings
All `git.*` tools SHALL return their results as `JSON.stringify`-ed strings in the `result` field (consistent with Phase 1-3 tools), with `metadata.duration_ms` for timing.

#### Scenario: Status result is JSON string
- **WHEN** `git.status` returns a successful status
- **THEN** `result` is a JSON string containing `currentBranch`, `staged`, `unstaged`, `untracked` fields, and `metadata.duration_ms` is set
