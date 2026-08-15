# tool-execution-failure-handling Specification

## Purpose
定义工具执行失败的统一兜底:路由层捕获所有异常并转为结构化失败结果(仅含错误消息、不含堆栈)回传模型,使 Agent 循环不中断、模型可据失败信息重新规划;系统不自动重试工具。

## Requirements

### Requirement: 执行失败统一兜底
The system SHALL catch exceptions from local execution, MCP adapter execution, STDIO spawn, remote HTTP/auth, protocol handling, validation and result normalization, and SHALL convert them into one structured ToolResult. Status SHALL be error with a readable message, or cancelled for user/AbortSignal cancellation. Returned errors MUST NOT contain stack traces, secrets, full stderr or unbounded remote bodies. AgentLoop SHALL continue after persisting the matching result.

#### Scenario: 本地 execute 失败
- **WHEN** a local execute throws `Error('boom')`
- **THEN** model receives error `boom` and loop continues

#### Scenario: STDIO 断连
- **WHEN** STDIO Server exits during tools/call
- **THEN** model receives a governed error under the original call ID

#### Scenario: 远程认证失败
- **WHEN** Streamable HTTP returns 401
- **THEN** model receives a readable authentication error without header values

#### Scenario: 多失败路径统一
- **WHEN** calls fail in validation, MCP isError, HTTP status, timeout and cancellation
- **THEN** each produces exactly one result under the shared contract

### Requirement: 失败重试语义
A failed result SHALL carry metadata.retryable. The system MUST NOT automatically replay a tools/call once it may have reached any STDIO or remote Server. Validation, permission, cancellation, destructive policy, authentication, unsupported Transport and configuration failures SHALL be non-retryable. Control-plane connect/tools-list MAY use bounded retry; a new business call remains a model decision.

#### Scenario: 参数错误不重试
- **WHEN** MCP arguments fail local schema validation
- **THEN** retryable is false and no protocol request is sent

#### Scenario: 远程响应中断不重放
- **WHEN** remote connection drops after tools/call may have reached Server
- **THEN** Harness returns an indeterminate non-auto-replayed failure

#### Scenario: 取消不重试
- **WHEN** user or AbortSignal cancels MCP call
- **THEN** result is cancelled and never auto-replayed

#### Scenario: 控制面有限恢复
- **WHEN** connect or tools/list has a transient failure before any business call
- **THEN** Connection MAY retry with a bounded policy

### Requirement: Transport 兼容失败分类
系统 SHALL 将 Streamable HTTP transport/protocol mismatch 与认证、TLS、DNS、超时、取消和 Server 5xx 区分。只有明确兼容失败且配置允许时才 SHALL 触发 legacy SSE fallback。

#### Scenario: 协议不匹配
- **WHEN** Streamable HTTP endpoint 明确表现为 legacy SSE-only
- **THEN** 错误可被分类为 compatibility 并允许配置控制的回退

#### Scenario: 401 不是兼容失败
- **WHEN** endpoint 返回 401
- **THEN** 错误分类为 authentication 且不触发 SSE fallback

### Requirement: MCP 生命周期失败隔离
MCP Store、Server 启动、远程连接、初始化、发现、刷新、调用和关闭失败 SHALL 按 Server ID 与阶段分类。运行时失败 SHALL 下线或保留未发布的仅该 Server 工具/instructions，不得删除其他 Server 或本地工具，也不得终止聊天。

#### Scenario: 一个远程 Server 失败
- **WHEN** remote Server error 而 STDIO Server ready
- **THEN** remote 工具下线，STDIO 和本地工具继续可用

#### Scenario: 关闭失败有界
- **WHEN** Server/Transport 关闭不完成
- **THEN** Manager 执行有界清理并结束 dispose，不无限等待
