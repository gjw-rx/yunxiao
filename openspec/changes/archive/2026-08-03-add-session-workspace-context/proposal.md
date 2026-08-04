## Why

切换模型后仍沿用原会话，会让后续请求继续绑定到此前 Agent 的云端上下文，造成模型与会话上下文不一致。云端 Agent 也缺少当前 VS Code 工作区根目录，无法建立与本地工具一致的工作目录认知。

## What Changes

- 用户在面板中选择不同 Agent（即切换模型）时，自动创建并切换到该 Agent 的新云端会话。
- 扩展在每次创建会话时上报当前工作区的根目录。
- 会话创建 API 新增可选工作区根目录字段，并提供面向云端 Agent 服务的接口对接文档。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `session-orchestration`: 切换 Agent 后必须隔离为新的云端会话。
- `tool-call-protocol`: 会话创建请求携带可选工作区根目录，供云端 Agent 使用。

## Impact

- `src/chatPanel.ts`：Agent 选择事件与工作区根目录采集。
- `src/aiClient.ts`：创建会话请求参数与请求体。
- `src/test/aiClient.test.ts` 及面板相关测试：覆盖请求体和切换模型创建新会话的行为。
- `docs/云端服务对接api/createSessionApi.md`：定义云端服务应接收和处理的会话创建请求。
