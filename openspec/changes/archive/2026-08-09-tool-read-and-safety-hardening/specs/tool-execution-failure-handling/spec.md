# tool-execution-failure-handling Specification

## Purpose
定义工具执行失败的统一兜底:路由层捕获所有异常并转为结构化失败结果(仅含错误消息、不含堆栈)回传模型,使 Agent 循环不中断、模型可据失败信息重新规划;系统不自动重试工具。

## ADDED Requirements

### Requirement: 执行失败统一兜底
The system SHALL catch all exceptions thrown by tool `execute` (and validation) in the routing layer and convert them into a structured `ToolResult` with `status: 'error'` and `error` set to the exception message. The agent loop SHALL continue after a failed tool call; the model receives the failure and decides whether/how to re-plan.

#### Scenario: execute 抛异常不中断循环
- **WHEN** a tool's `execute` throws `Error('boom')`
- **THEN** the model receives `status: 'error'` with `error: 'boom'` and the agent loop continues to the next step

#### Scenario: 错误信息不含堆栈
- **WHEN** the thrown error carries a `stack` property
- **THEN** the returned `error` field contains only the error message, never the stack trace

#### Scenario: 多条错误路径收敛
- **WHEN** a tool fails both in `validate` and in `execute` across different calls
- **THEN** both failures return the same structured error shape, and neither throws an uncaught exception

### Requirement: 失败重试语义
A failed tool result SHALL carry `metadata.retryable` indicating whether retrying the same call is likely to help. The system SHALL NOT automatically retry failed tool executions; retry decisions are left to the model.

#### Scenario: 参数错误不可重试
- **WHEN** a call fails argument validation
- **THEN** the result carries `metadata.retryable: false` (the model should rewrite the arguments rather than repeat)

#### Scenario: 可重试业务失败
- **WHEN** a tool reports a transient, explicitly retryable failure
- **THEN** the result carries `metadata.retryable: true` and the model may retry with adjustment

#### Scenario: 中断结果不重试
- **WHEN** a call is cancelled via the abort signal or user rejection
- **THEN** the result uses `status: 'cancelled'` semantics and is never auto-replayed
