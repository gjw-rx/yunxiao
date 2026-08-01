# 本地工具（Local Tool）接口文档

> 面向 VSCode 插件侧。云端只声明工具 schema、不执行；工具被 LLM 调用时云端 `interrupt` 暂停图执行，由插件本地执行后回传结果续流。

## 1. 机制概述

- 插件在**创建会话**时通过 `local_tools` 字段上报工具声明（name + description + JSON Schema 参数）。
- 云端用 `make_local_tool` 把声明包装成「调用即 interrupt」的 LangChain 工具，编译进会话级 agent。
- LLM 决定调用本地工具时，云端流式返回 `tool_call` 事件并暂停图。
- 插件执行完工具后，调用 `/tool_result` 端点回传结果，云端恢复图执行并继续流式返回后续事件。
- 一轮对话中可能连续多次 `tool_call`（每次回传后续流，可能再次 interrupt）。

完整时序见 [§5 交互时序](#5-交互时序)。

## 2. 创建会话时上报本地工具

### 端点

`POST /api/agent/invoke/session`

### 请求体

```json
{
  "agent_id": "agent_xxx",
  "local_tools": [
    {
      "name": "fs.read_file",
      "description": "读取指定路径的文件内容",
      "parameters": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "文件绝对路径" }
        },
        "required": ["path"]
      },
      "permissions": "read",
      "site": "local"
    }
  ]
}
```

### 字段说明

| 字段            | 类型                              | 必填 | 默认值   | 说明                                              |
| --------------- | --------------------------------- | ---- | -------- | ------------------------------------------------- |
| `agent_id`    | `string`                        | 是   | -        | Agent ID                                          |
| `local_tools` | `array<LocalToolSchema> \| null` | 否   | `null` | 本地工具声明列表；`null` 或空数组表示纯聊天会话 |

### LocalToolSchema

| 字段            | 类型       | 必填 | 默认值      | 说明                                                                |
| --------------- | ---------- | ---- | ----------- | ------------------------------------------------------------------- |
| `name`        | `string` | 是   | -           | 工具唯一名称，建议用命名空间格式（如`fs.read_file`）              |
| `description` | `string` | 是   | -           | 工具描述，供 LLM 理解工具用途，**直接影响 LLM 调用决策**      |
| `parameters`  | `object` | 是   | -           | JSON Schema 格式的参数声明，见[§2.1](#21-parameters-格式)           |
| `permissions` | `string` | 否   | `""`      | 权限标识（如`"read"`、`"write"`），当前为声明性字段，云端不消费 |
| `site`        | `string` | 否   | `"local"` | 工具执行位置，固定`"local"`                                       |

### 2.1 `parameters` 格式

标准 JSON Schema object。云端只解析以下字段，其余高级特性（`enum`/`format`/`additionalProperties` 等）**不处理**：

| 字段           | 说明                                                       |
| -------------- | ---------------------------------------------------------- |
| `type`       | 顶层约定`"object"`（代码不强制校验）                     |
| `properties` | 属性定义，key 为参数名，value 含`type` + `description` |
| `required`   | 必填参数名列表（可选）                                     |

支持的参数 `type` 映射：

| JSON Schema type | Python 类型   |
| ---------------- | ------------- |
| `string`       | `str`       |
| `integer`      | `int`       |
| `number`       | `float`     |
| `boolean`      | `bool`      |
| `array`        | `list`      |
| `object`       | `dict`      |
| 其他/缺省        | 降级为`str` |

无 `properties` 或 `properties` 为空时，工具无参数校验。

### 2.2 响应

```json
{
  "success": true,
  "data": { "session_id": "a1b2c3...", "agent_id": "agent_xxx" }
}
```

`session_id` 即后续流式对话与工具结果回传使用的会话 ID（= LangGraph thread_id）。

## 3. 流式对话中接收 `tool_call` 事件

### 端点

`POST /api/agent/invoke/message/stream`

返回 `text/event-stream`（SSE），每行格式 `data: {json_line}\n\n`。

### 事件类型

| `type`       | `data` 类型 | 含义                                         |
| -------------- | ------------- | -------------------------------------------- |
| `content`    | `string`    | LLM 流式输出文本                             |
| `thought`    | `string`    | 中间轮 LLM 思考文本（有 tool_calls 时）      |
| `tool_start` | `string`    | **云端**工具开始执行（工具名）         |
| `tool_end`   | `string`    | **云端**工具执行结束（输出内容）       |
| `tool_call`  | `object`    | **本地工具**调用，需插件执行后回传结果 |

### `tool_call` 事件结构

```json
{
  "type": "tool_call",
  "data": {
    "call_id": "c1d2e3f4...",
    "tool": "fs.read_file",
    "args": { "path": "src/extension.ts" },
    "site": "local",
    "require_approval": false
  }
}
```

| 字段路径                  | 类型        | 说明                                                       |
| ------------------------- | ----------- | ---------------------------------------------------------- |
| `data.call_id`          | `string`  | 唯一调用 ID（uuid4 hex），**回传结果时必须原样带回** |
| `data.tool`             | `string`  | 工具名，对应上报的`LocalToolSchema.name`                 |
| `data.args`             | `object`  | LLM 传入的参数，key 对应`parameters.properties`          |
| `data.site`             | `string`  | 固定`"local"`                                            |
| `data.require_approval` | `boolean` | 固定`false`（Phase 1 约束，不要求用户审批）              |

收到 `tool_call` 事件后，流会**结束**（图已暂停）。插件需执行工具并调用 [§4](#4-回传工具执行结果) 续流。

## 4. 回传工具执行结果

### 端点

`POST /api/agent/invoke/tool_result`

返回 `text/event-stream`（SSE），续流返回后续 agent 事件（`content`/`thought`/`tool_call` 等，格式同 [§3](#3-流式对话中接收-tool_call-事件)）。

### 请求体

```json
{
  "session_id": "a1b2c3...",
  "call_id": "c1d2e3f4...",
  "status": "success",
  "result": "文件内容...",
  "error": null,
  "metadata": null
}
```

### 字段说明

| 字段           | 类型                                  | 必填 | 说明                                                               |
| -------------- | ------------------------------------- | ---- | ------------------------------------------------------------------ |
| `session_id` | `string`                            | 是   | 会话 ID（来自创建会话响应）                                        |
| `call_id`    | `string`                            | 是   | 工具调用 ID（来自`tool_call` 事件的 `data.call_id`，原样带回） |
| `status`     | `"success" \| "error" \| "cancelled"` | 是   | 执行状态                                                           |
| `result`     | `string \| null`                     | 否   | 执行结果文本（`status="success"` 时提供）                        |
| `error`      | `string \| null`                     | 否   | 错误信息（`status="error"` 时提供）                              |
| `metadata`   | `object \| null`                     | 否   | 元数据（当前云端不消费）                                           |

### status 映射

| `status`    | 云端注入给 LLM 的 ToolMessage content   |
| ------------- | --------------------------------------- |
| `success`   | `result`（为空则 `""`）             |
| `error`     | `error`（为空则 `"unknown error"`） |
| `cancelled` | `"cancelled"`                         |

### 续流行为

- 云端用 `Command(resume=ToolMessage(...))` 恢复图执行，LLM 看到工具结果后继续生成。
- 续流中若再次触发本地工具（下一个 `tool_call`），会再次 yield `tool_call` 事件，插件需再次回传，循环直至 `content` 流结束。

## 5. 交互时序

```
插件                          云端 Agent (LangGraph)                     LLM
 │  POST /message/stream           │                                         │
 │  "读 src/extension.ts 并总结"    │                                         │
 │ ───────────────────────────────>│                                         │
 │ <─SSE: content/thought──────────│  LLM 决策调用 fs.read_file              │
 │                                 │  ToolNode 执行 -> interrupt() 暂停图     │
 │ <─SSE: tool_call────────────────│  yield tool_call 事件，流结束            │
 │  本地执行读文件                  │                                         │
 │  POST /tool_result              │                                         │
 │  {call_id, status, result}      │                                         │
 │ ───────────────────────────────>│  Command(resume=ToolMessage) 恢复图      │
 │ <─SSE: content (总结)───────────│  LLM 基于文件内容生成总结                │
 │ <─SSE: [done]──────────────────│  流结束                                  │
```

## 6. 约束（Phase 1）

- 每轮至多一个本地 `tool_call`（续流可链式多次）。
- `require_approval` 始终 `false`，无需用户审批。
- `local_tools` 在会话级内存缓存，落库 JSON 列仅供会话恢复重建。
- 本地工具仅支持异步路径（LangGraph async），同步调用直接抛 `NotImplementedError`。
- `parameters` 高级 JSON Schema 特性（`enum`/`format`/`additionalProperties` 等）不解析，参数校验仅基于 `type` + `required`。

## 7. 完整示例

### 7.1 上报两个本地工具

```json
POST /api/agent/invoke/session
{
  "agent_id": "agent_xxx",
  "local_tools": [
    {
      "name": "fs.read_file",
      "description": "读取指定路径的文件内容",
      "parameters": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "文件绝对路径" }
        },
        "required": ["path"]
      },
      "permissions": "read",
      "site": "local"
    },
    {
      "name": "fs.write_file",
      "description": "写入文件",
      "parameters": { "type": "object", "properties": {} },
      "permissions": "write",
      "site": "local"
    }
  ]
}
```

### 7.2 接收 tool_call 并回传结果

```json
// SSE 收到
data: {"type":"tool_call","data":{"call_id":"c1","tool":"fs.read_file","args":{"path":"src/extension.ts"},"site":"local","require_approval":false}}

// 插件回传
POST /api/agent/invoke/tool_result
{
  "session_id": "a1b2c3...",
  "call_id": "c1",
  "status": "success",
  "result": "export function activate() { ... }"
}

// SSE 续流
data: {"type":"content","data":"这个文件定义了 activate 函数..."}
```
