# tool-argument-validation Specification

## Purpose
定义工具参数的运行时 JSON Schema 校验与结构化失败反馈:注册时编译解码器、路由前统一校验、失败返回带指导文案的结构化错误(不抛未捕获异常),帮助模型重写输入。

## Requirements

### Requirement: 注册时编译参数解码器
The system SHALL compile a runtime argument decoder from each tool's `parameters` (JSON Schema) at registration time (once per tool, not per call), and the router SHALL run this decoder against the arguments of every local tool call before execution.

#### Scenario: 合法参数通过校验
- **WHEN** a tool call's arguments satisfy the tool's JSON Schema
- **THEN** the call proceeds to execution without error

#### Scenario: 缺失必填参数被拒绝
- **WHEN** `fs.read_file` is called without the required `path` argument
- **THEN** the router returns `status: 'error'` before execution, with a message naming the missing field and instructing the model to rewrite the input to satisfy the schema

#### Scenario: 参数类型错误被拒绝
- **WHEN** `fs.read_file` is called with `offset: "abc"` (a string where a number is expected)
- **THEN** the router returns `status: 'error'` with a type-mismatch message and does not execute the tool

### Requirement: 校验失败返回结构化错误
Argument validation failures SHALL be returned as a structured `ToolResult` with `status: 'error'`; they SHALL NOT throw an uncaught exception into the agent loop. The error message SHALL include the specific validation detail and a rewrite guidance sentence (e.g. `The <tool> tool was called with invalid arguments: <detail>. Please rewrite the input so it satisfies the expected schema.`).

#### Scenario: 校验失败不中断循环
- **WHEN** argument validation fails
- **THEN** the agent loop receives a structured error result and continues, allowing the model to re-plan the call

#### Scenario: 手写 validate 保持兼容
- **WHEN** a tool overrides `validate` with extra business checks
- **THEN** both the schema decoder and the custom `validate` run before execution, and either failure returns the structured error
