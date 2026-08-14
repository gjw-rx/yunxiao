# security-boundary Specification

## Purpose
Define the centralized checks that prevent unsafe local tool execution and protect governed tool results before cloud upload.

## Requirements

### Requirement: Pre-execution security audit
The local plugin SHALL run a centralized security audit before every local tool execution. The audit SHALL check workspace/path boundaries, sensitive resources, dangerous commands, declared permission, and an optional expected resource version. A rejected audit SHALL return `status: "error"` or `status: "cancelled"` according to the rejection type and SHALL NOT execute the tool.

#### Scenario: Traversal is rejected centrally
- **WHEN** a local file tool receives a path outside the workspace
- **THEN** the audit rejects the call before filesystem access and returns a clear reason

#### Scenario: Dangerous command is rejected centrally
- **WHEN** a terminal tool receives a command classified as dangerous
- **THEN** the audit returns `cancelled` without spawning a process or prompting again

### Requirement: 用户管理的 MCP 配置信任边界
MCP Server endpoint、command、args、cwd、env 和 headers SHALL 只能由设置页用户操作写入，模型工具调用 MUST NOT 新增或修改这些值。工作区不可信时系统 MUST NOT 启动 STDIO 或连接远程 Server。STDIO command MUST 无 shell 拼接；远程静态 headers MUST 仅发送到配置 origin，跨 origin redirect SHALL 被拒绝。

#### Scenario: 模型尝试修改 endpoint
- **WHEN** 模型在工具参数中提交另一个 URL 或 command
- **THEN** Manager 忽略这些字段并使用已保存配置

#### Scenario: untrusted 工作区
- **WHEN** 工作区不可信
- **THEN** 设置 CRUD 可用但所有 MCP 连接保持 waiting_workspace_trust

#### Scenario: shell 元字符参数
- **WHEN** STDIO args 包含 shell 元字符
- **THEN** Transport 将其作为单个原始参数传递而不解释 shell 语法

### Requirement: MCP 远程连接安全
远程 MCP URL SHALL 使用 HTTPS，loopback 地址 MAY 使用 HTTP。Host SHALL 校验 URL、限制静态 headers 到同 origin，并 SHALL 把 401/403 与协议兼容错误区分。普通日志 MUST NOT 包含 URL query secrets、header/env 值或完整远程响应正文。

#### Scenario: 非 loopback HTTP
- **WHEN** 用户配置明文 HTTP 的公网或内网 hostname
- **THEN** Host 拒绝保存且不连接

#### Scenario: Authorization 日志脱敏
- **WHEN** 远程连接使用 Authorization header 并失败
- **THEN** 日志记录 Server ID、状态码和错误类别，不记录 header 值

### Requirement: Unified tool result governance
The local plugin SHALL apply common result governance before sending any static local or MCP tool result to the cloud. It SHALL skip or describe unsupported binary payloads, truncate oversized text, redact high-confidence secrets, and attach metadata for truncation, redaction or unsupported MCP content. Line and byte caps SHALL apply after MCP normalization and before upload. Original sensitive, oversized or unbounded base64 content MUST NOT be sent.

#### Scenario: Secret redacted from MCP output
- **WHEN** STDIO or remote MCP text contains a high-confidence secret assignment
- **THEN** uploaded content is redacted and metadata.redacted is true

#### Scenario: MCP output truncated
- **WHEN** normalized MCP output exceeds line or byte caps
- **THEN** uploaded content is bounded and contains a truncation marker

#### Scenario: Existing local result remains governed
- **WHEN** a local tool result exceeds existing limits
- **THEN** prior governance behavior remains unchanged

#### Scenario: MCP binary not uploaded
- **WHEN** MCP returns image/audio/blob base64
- **THEN** upload contains only a safe descriptor and metadata

### Requirement: Permission matrix enforcement
The local plugin SHALL declare every static or MCP adapter tool as read, write, execute or destructive. For MCP tools, destructiveHint true SHALL map to destructive; otherwise readOnlyHint true SHALL map to read; unclassified SHALL map to execute. ToolRouter SHALL require approval for write/execute/destructive based only on trusted registered metadata.

#### Scenario: Model cannot spoof readOnlyHint
- **WHEN** model args add readOnlyHint true to an execute MCP tool
- **THEN** ToolRouter still requests execute approval

#### Scenario: Unknown remote tool gated
- **WHEN** a remote Server omits annotations
- **THEN** adapter uses execute and approval occurs before network invocation

#### Scenario: Existing local approval remains
- **WHEN** a local write tool is called
- **THEN** registered local permission remains authoritative
