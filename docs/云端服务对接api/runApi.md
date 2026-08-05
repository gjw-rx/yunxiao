# Run 接口（v2）对接文档

> 面向 VSCode 插件侧。v2 Run 接口采用**计算与订阅分离**架构：启动对话、订阅事件、提交工具结果、查询状态均为独立端点，
> 支持断线重连、游标补发、幂等重试。本接口替代旧版 `invoke/message/stream` + `invoke/tool_result` 的耦合式 SSE。

---

## 1. 机制概述

```
插件                              云端 Agent (LangGraph)                     LLM
 │  POST /api/v2/agent/run           │                                         │
 │  {session_id, text, client_request_id}                                     │
 │ ─────────────────────────────────>│                                         │
 │ <──JSON: {run_id, status}─────────│  后台任务启动，LangGraph 开始计算         │
 │                                   │                                         │
 │  GET /api/v2/agent/run/{run_id}/events?after_sequence=0                    │
 │ ─────────────────────────────────>│                                         │
 │ <─SSE: content/thought────────────│  LLM 流式输出                            │
 │ <─SSE: tool_start (云端工具)──────│  云端工具执行                            │
 │ <─SSE: tool_end (云端工具)────────│  云端工具结束                            │
 │ <─SSE: run_status(interrupted)────│  本地工具触发 interrupt，图暂停           │
 │ <─SSE: tool_call (本地工具)───────│  通知插件执行本地工具                    │
 │  [SSE 结束]                       │                                         │
 │  本地执行工具                      │                                         │
 │  POST /api/v2/agent/run/{run_id}/tool-result                                │
 │  {results: [...]}                 │                                         │
 │ ─────────────────────────────────>│  Command(resume) 恢复图执行              │
 │ <──JSON: {run_id, status}─────────│  后台续算任务启动                        │
 │                                   │                                         │
 │  GET /api/v2/agent/run/{run_id}/events?after_sequence=N                    │
 │ ─────────────────────────────────>│                                         │
 │ <─SSE: content (最终回复)─────────│  LLM 基于工具结果生成回复                │
 │ <─SSE: run_status(completed)──────│  流结束                                  │
 │  [SSE 结束]                       │                                         │
```

**核心特征：**

- **计算与订阅分离**：POST 启动计算返回 JSON（不阻塞），GET 订阅事件返回 SSE。两端点独立，可分别重试。
- **sequence 游标**：每个持久事件带单调递增 `sequence`，断线后用 `after_sequence` 参数补发未读事件。
- **幂等准入**：Run 按 `(session_id, client_request_id)` 唯一约束，重复提交返回同一 Run。
- **批量工具结果**：一次 `tool_call` 可能包含多个并行本地工具调用，插件批量执行后一次性回传。

---

## 2. 前置：创建会话

Run 接口不负责创建会话，沿用旧端点。

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
  ],
  "workspace_root": "/Users/project"
}
```

### 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `agent_id` | `string` | 是 | - | Agent ID |
| `local_tools` | `array<LocalToolSchema> \| null` | 否 | `null` | 本地工具声明列表；`null` 或空数组表示纯聊天会话 |
| `workspace_root` | `string \| null` | 否 | `null` | 工作区根目录，供模型感知环境；不传时回退服务进程 cwd |

### LocalToolSchema

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | `string` | 是 | - | 工具唯一名称，建议命名空间格式（如 `fs.read_file`） |
| `description` | `string` | 是 | - | 工具描述，**直接影响 LLM 调用决策** |
| `parameters` | `object` | 是 | - | JSON Schema 参数声明（`type`/`properties`/`required`） |
| `permissions` | `string` | 否 | `""` | 权限标识：`read` / `write` / `destructive` / `execute`。**影响 `require_approval`** |
| `site` | `string` | 否 | `"local"` | 固定 `"local"` |

### permissions 与 require_approval 映射

| `permissions` | `require_approval`（tool_call 事件中） | 说明 |
|---------------|----------------------------------------|------|
| `"read"` | `false` | 只读工具，无需用户审批 |
| `"write"` / `"destructive"` / `"execute"` / 其他 | `true` | 非 read 权限需用户审批，插件应弹出确认 UI |

### 响应

```json
{
  "success": true,
  "data": { "session_id": "a1b2c3...", "agent_id": "agent_xxx" }
}
```

`session_id` 即后续 Run 启动与工具结果回传使用的会话 ID（= LangGraph thread_id）。

---

## 3. 启动 Run

### 端点

`POST /api/v2/agent/run`

### 请求体

```json
{
  "session_id": "a1b2c3...",
  "text": "读 src/extension.ts 并总结",
  "client_request_id": "req-001"
}
```

| 字段 | 类型 | 必填 | 约束 | 说明 |
|------|------|------|------|------|
| `session_id` | `string` | 是 | `min_length=1` | 来自创建会话响应 |
| `text` | `string` | 是 | `min_length=1` | 用户输入文本 |
| `client_request_id` | `string` | 是 | `min_length=1, max_length=128` | **幂等键**，同一 `(session_id, client_request_id)` 重复提交返回同一 Run |

> **幂等机制**：网络重试时传相同的 `client_request_id`，服务端返回已存在的 Run，不会重复启动计算。

### 响应

```json
{
  "success": true,
  "data": {
    "run_id": "run_abc123",
    "session_id": "a1b2c3...",
    "status": "pending",
    "created": true
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.run_id` | `string` | Run 唯一 ID，后续订阅、提交结果、查询状态均使用此 ID |
| `data.session_id` | `string` | 会话 ID |
| `data.status` | `string` | Run 当前状态（见 [§7 状态机](#7-run-状态机)） |
| `data.created` | `boolean` | `true` 表示新创建并已启动后台计算；`false` 表示命中幂等返回已存在 Run |

> 启动后立即返回，**不等待计算完成**。插件需紧接着调用 [§4 订阅事件](#4-订阅事件) 获取 SSE 流。

---

## 4. 订阅事件

### 端点

`GET /api/v2/agent/run/{run_id}/events`

### 查询参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `after_sequence` | `int` | 否 | `0` | 排他游标，返回 `sequence > after_sequence` 的事件。用于断线重连补发未读事件 |

### 响应

`text/event-stream`（SSE），每行格式：

```
data: {"sequence":N,"event_type":"<type>","payload":{"type":"...","data":...}}\n\n
data: {"sequence":null,"event_type":"content","payload":{"type":"content","data":"..."}}\n\n
```

> **重要**：`content` 事件的 `sequence` 为 `null`（瞬态事件，不落库）；其他事件（`thought`/`tool_start`/`tool_end`/`tool_call`/`run_status`）的 `sequence` 为单调递增整数（持久事件）。

### v2 SSE 信封结构

每条 SSE 数据是带 `sequence` 的信封，`payload` 内才是实际事件：

```typescript
interface RunEventEnvelope {
    sequence: number | null;   // 持久事件为单调递增整数；content chunk 为 null（瞬态，不落库）
    event_type: string;        // 事件类型：content/thought/tool_start/tool_end/tool_call/run_status
    payload: {
        type: string;          // 与 event_type 相同
        data: string | object | object[];  // 事件数据，结构见 §5
    };
}
```

### 订阅停止条件

SSE 在以下情况结束：

| 条件 | 说明 |
|------|------|
| Run 状态变为 `interrupted` | 本地工具触发 interrupt，等待插件执行并回传结果 |
| Run 状态变为 `completed` | 正常结束 |
| Run 状态变为 `failed` | 计算异常 |
| Run 状态变为 `cancelled` | 被取消 |

> 当 SSE 因 `interrupted` 结束时，插件需执行本地工具后调用 [§6 提交工具结果](#6-提交工具结果)，再重新订阅事件获取续流。

---

## 5. SSE 事件类型

### 5.1 `content` 事件（LLM 流式文本）

```json
{
  "sequence": null,
  "event_type": "content",
  "payload": {
    "type": "content",
    "data": "你好"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `sequence` | `null` | **content 是瞬态事件，不落库，sequence 固定为 null** |
| `payload.data` | `string` | LLM 输出的文本片段（逐 chunk 推送，需拼接） |

> **性能优化**：content chunk 走内存广播通道实时推送，不经过数据库事务，延迟从 10-40ms/chunk 降至微秒级。
> 断线重连时，若 Run 已 `completed`，服务端从 `InvokeMessage` 归档的完整 assistant 文本一次性重建为单个 content 事件推送（而非逐 chunk 补发）。

### 5.2 `thought` 事件（中间轮思考）

```json
{
  "sequence": 2,
  "event_type": "thought",
  "payload": {
    "type": "thought",
    "data": "我需要先读取文件内容..."
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `payload.data` | `string` | 中间轮 LLM 思考文本（有 tool_calls 时推送，最终轮不推送） |

### 5.3 `tool_start` 事件（云端工具开始）

```json
{
  "sequence": 3,
  "event_type": "tool_start",
  "payload": {
    "type": "tool_start",
    "data": {
      "run_id": "run_abc123",
      "name": "skills_list",
      "input": {},
      "tool_call_id": "call_xxx"
    }
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `payload.data.run_id` | `string` | LangGraph Runnable 运行 ID，**用于配对 `tool_end`** |
| `payload.data.name` | `string` | 云端工具名（如 `skills_list`、`skill_view`、`memory`） |
| `payload.data.input` | `object` | LLM 传入的工具参数（可能为空对象 `{}`） |
| `payload.data.tool_call_id` | `string \| null` | LLM 层面的工具调用 ID（可能为 null，需兼容） |

### 5.4 `tool_end` 事件（云端工具结束）

```json
{
  "sequence": 4,
  "event_type": "tool_end",
  "payload": {
    "type": "tool_end",
    "data": {
      "run_id": "run_abc123",
      "name": "skills_list",
      "output": "{\"success\":true,\"skills\":[...]}",
      "tool_call_id": "call_xxx"
    }
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `payload.data.run_id` | `string` | 与对应 `tool_start` 的 `run_id` **相同** |
| `payload.data.name` | `string` | 云端工具名 |
| `payload.data.output` | `string` | 工具执行结果文本（可能是 JSON 字符串或纯文本） |
| `payload.data.tool_call_id` | `string \| null` | LLM 层面的工具调用 ID |

> **云端工具**由服务端执行，插件**只读展示**，无需执行、无需回传。通过 `run_id` 配对 `tool_start` / `tool_end`。

### 5.5 `tool_call` 事件（本地工具调用）

```json
{
  "sequence": 5,
  "event_type": "tool_call",
  "payload": {
    "type": "tool_call",
    "data": [
      {
        "call_id": "c1d2e3f4...",
        "tool": "fs.read_file",
        "args": { "path": "src/extension.ts" },
        "site": "local",
        "require_approval": false
      },
      {
        "call_id": "e5f6g7h8...",
        "tool": "fs.write_file",
        "args": { "path": "out.txt", "content": "..." },
        "site": "local",
        "require_approval": true
      }
    ]
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `payload.data` | **`array<object>`** | **本地工具调用数组**（LLM 一次响应可能并行发起多个调用） |
| `data[i].call_id` | `string` | 唯一调用 ID（uuid4 hex），**回传结果时必须原样带回** |
| `data[i].tool` | `string` | 工具名，对应上报的 `LocalToolSchema.name` |
| `data[i].args` | `object` | LLM 传入的参数，key 对应 `parameters.properties` |
| `data[i].site` | `string` | 固定 `"local"` |
| `data[i].require_approval` | `boolean` | `read` 权限为 `false`，非 `read` 权限为 `true` |

> **重要**：
> - `data` 是**数组**，插件需遍历执行全部调用后**批量回传**。
> - `require_approval=true` 时，插件应弹出用户确认 UI。用户拒绝则回传 `status: "cancelled"`。
> - 收到 `tool_call` 后 SSE 会结束（Run 已 interrupted），插件需执行工具后调用 [§6](#6-提交工具结果) 续流。

### 5.6 `run_status` 事件（Run 状态变更）

```json
{
  "sequence": 6,
  "event_type": "run_status",
  "payload": {
    "type": "run_status",
    "data": {
      "run_id": "run_abc123",
      "session_id": "a1b2c3...",
      "status": "interrupted"
    }
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `payload.data.run_id` | `string` | Run ID |
| `payload.data.session_id` | `string` | 会话 ID |
| `payload.data.status` | `string` | Run 新状态（见 [§7](#7-run-状态机)） |

> `run_status` 在状态转换时推送：`pending -> running -> interrupted -> running -> completed` 等。
> 插件可据此更新 UI 状态指示器。`interrupted` 状态后 SSE 即将结束，需等待 `tool_call` 事件。

---

## 6. 提交工具结果

### 端点

`POST /api/v2/agent/run/{run_id}/tool-result`

### 路径参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `run_id` | `string` | Run ID（来自启动 Run 响应） |

### 请求体

```json
{
  "results": [
    {
      "call_id": "c1d2e3f4...",
      "status": "success",
      "result": "文件内容...",
      "error": null,
      "metadata": { "retryable": null, "truncated": true, "redacted": false }
    },
    {
      "call_id": "e5f6g7h8...",
      "status": "cancelled",
      "result": null,
      "error": null,
      "metadata": null
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `results` | `array<ToolCallResultIn>` | 是 | 至少 1 个，对应 `tool_call` 事件的 `data` 数组 |
| `results[i].call_id` | `string` | 是 | 来自 `tool_call` 的 `call_id`，原样带回 |
| `results[i].status` | `"success" \| "error" \| "cancelled"` | 是 | 执行状态 |
| `results[i].result` | `string \| null` | 否 | 执行结果文本（`status="success"` 时提供） |
| `results[i].error` | `string \| null` | 否 | 错误信息（`status="error"` 时提供） |
| `results[i].metadata` | `ToolResultMetadata \| null` | 否 | 结果元数据 |

### ToolResultMetadata

| 字段 | 类型 | 说明 |
|------|------|------|
| `retryable` | `boolean \| null` | 错误是否可重试（缺省 `null` 按不可重试处理） |
| `truncated` | `boolean \| null` | 本地已裁剪标记（云端只记录不恢复原文） |
| `redacted` | `boolean \| null` | 本地已脱敏标记（云端只记录不恢复原文） |

### status 映射（云端注入给 LLM 的 ToolMessage content）

| `status` | 注入给 LLM 的内容 |
|----------|-------------------|
| `success` | `result`（为空则 `""`） |
| `error` | `error`（为空则 `"unknown error"`） |
| `cancelled` | `"cancelled"` |

### 响应

```json
{
  "success": true,
  "data": {
    "run_id": "run_abc123",
    "status": "running"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.run_id` | `string` | Run ID |
| `data.status` | `string` | 续算后的状态（`"running"`） |

> **重要**：提交结果返回的是 **JSON**，不是 SSE。插件需紧接着重新调用 [§4 订阅事件](#4-订阅事件) 获取续流。
> 续流订阅时传入 `after_sequence` = 提交结果前记录的最后 `sequence`，可补发期间可能错过的事件。

### 幂等机制

- 同一 `(run_id, call_id)` 重复提交，服务端返回已接受回执，不重复续算。
- 若提交的 `result` 内容与已接受回执冲突（hash 不一致），返回错误：`工具结果与已接受回执冲突`。

---

## 7. Run 状态机

### 状态定义

| 状态 | 说明 |
|------|------|
| `pending` | 已创建，等待后台任务启动 |
| `running` | 后台计算中 |
| `interrupted` | 本地工具触发 interrupt，等待插件提交工具结果 |
| `completed` | 正常完成（终态） |
| `failed` | 计算异常（终态） |
| `cancelled` | 被取消（终态） |

### 状态流转

```
pending ──> running ──> completed
              │  ↑
              │  └── 提交 tool-result 后恢复
              ↓
          interrupted ──> running ──> completed
              │
              └──> failed / cancelled（异常路径）
```

### 终态

`completed` / `failed` / `cancelled` 为终态，Run 不再变化，事件订阅结束。

---

## 8. 查询 Run 状态

### 端点

`GET /api/v2/agent/run/{run_id}`

### 响应

```json
{
  "success": true,
  "data": {
    "run_id": "run_abc123",
    "session_id": "a1b2c3...",
    "client_request_id": "req-001",
    "status": "interrupted",
    "last_sequence": 5
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.run_id` | `string` | Run ID |
| `data.session_id` | `string` | 会话 ID |
| `data.client_request_id` | `string` | 幂等键 |
| `data.status` | `string` | 当前状态 |
| `data.last_sequence` | `int` | 最新已提交事件序号（= `next_event_sequence - 1`） |

> **用途**：断线恢复时查询当前状态和最新 sequence，判断是否需要重新订阅事件。

---

## 9. 断线重连

v2 接口支持断线重连，核心靠 `sequence` 游标：

```
1. 插件维护本地 last_sequence（每收到一条 SSE 更新）
2. 网络断开时：
   a. GET /api/v2/agent/run/{run_id} 查询当前状态和 last_sequence
   b. 若 Run 仍在 running / interrupted，重新订阅事件
   c. GET /api/v2/agent/run/{run_id}/events?after_sequence={本地last_sequence}
3. 服务端补发 last_sequence 之后的所有未读事件，继续订阅
```

```typescript
// 断线重连示例
async function reconnect(runId: string, localLastSequence: number): Promise<void> {
    // 1. 查询当前状态
    const status = await fetchRunStatus(runId);
    if (['completed', 'failed', 'cancelled'].includes(status.status)) {
        return; // 已终态，无需重连
    }

    // 2. 从本地游标继续订阅，服务端会补发漏掉的事件
    await subscribeEvents(runId, status.last_sequence > localLastSequence
        ? localLastSequence  // 用本地游标，补发可能漏掉的
        : localLastSequence
    );
}
```

---

## 10. 云端工具与本地工具对比

| 维度 | 云端工具 | 本地工具 |
|------|----------|----------|
| 执行位置 | 服务端 | 插件端（VSCode 本地） |
| 事件类型 | `tool_start` + `tool_end` | `tool_call` |
| 插件职责 | 只读展示 | 执行 + 回传结果 |
| 典型工具 | `skills_list`、`skill_view`、`memory` | `fs.read_file`、`code.edit`、`terminal.exec` |
| data 结构 | object（含 run_id/name/input/output） | **array**（含 call_id/tool/args/site/require_approval） |
| 配对方式 | `run_id` 配对 start/end | 无配对（批量 tool_call） |
| 结果来源 | `tool_end.data.output` | 插件本地执行后回传 `tool-result` |
| `on_tool_start` | 正常推送 | **被服务端抑制**（不推送 tool_start/tool_end） |

### 已注册的云端工具

| 工具名 | 工具集 | 说明 |
|--------|--------|------|
| `skills_list` | `skills` | 列出已注册的技能（Skill）清单 |
| `skill_view` | `skills` | 查看指定技能的完整内容 |
| `memory` | `memory` | 记忆存储（用户意向记忆的增删改查） |

> 云端工具清单可通过 `GET /api/agent/config` 获取 Agent 配置中的 `enabled_tools` / `toolset` 字段推断。

---

## 11. 事件时序

一轮对话中，云端工具和本地工具可能交替出现：

```
SSE 事件流（v2 信封，此处省略 sequence/event_type，只展示 payload）：

  run_status(running)     ← Run 开始计算
  thought                 ← LLM 思考（有 tool_calls 时）
  tool_start              ← 云端工具 skills_list 开始
  tool_end                ← 云端工具 skills_list 结束
  thought                 ← LLM 再次思考（基于工具结果决策下一步）
  run_status(interrupted) ← 本地工具触发 interrupt，图暂停
  tool_call               ← 本地工具 fs.read_file（需插件执行后回传）
  [SSE 结束]

  （插件执行工具，POST tool-result，重新订阅）

  run_status(running)     ← 续算开始
  content                 ← LLM 最终回复（逐 chunk）
  run_status(completed)   ← 流结束
  [SSE 结束]
```

---

## 12. 完整对接示例（TypeScript）

```typescript
import * as http from 'http';
import { URL } from 'url';

// ============ 类型定义 ============

/** v2 SSE 信封 */
interface RunEventEnvelope {
    sequence: number | null;  // 持久事件为整数；content chunk 为 null
    event_type: string;
    payload: {
        type: string;
        data: string | object | object[];
    };
}

/** 本地工具调用 payload */
interface ToolCallPayload {
    call_id: string;
    tool: string;
    args: Record<string, unknown>;
    site: 'local';
    require_approval: boolean;
}

/** 工具结果回传项 */
interface ToolCallResult {
    call_id: string;
    status: 'success' | 'error' | 'cancelled';
    result?: string | null;
    error?: string | null;
    metadata?: { retryable?: boolean | null; truncated?: boolean | null; redacted?: boolean | null } | null;
}

/** Run 状态 */
type RunStatus = 'pending' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

const TERMINAL_STATUSES: Set<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

// ============ 回调接口 ============

interface RunCallbacks {
    onContent: (text: string) => void;
    onThought?: (text: string) => void;
    onToolStart?: (data: { run_id: string; name: string; input: object; tool_call_id: string | null }) => void;
    onToolEnd?: (data: { run_id: string; name: string; output: string; tool_call_id: string | null }) => void;
    onToolCall?: (payloads: ToolCallPayload[]) => void;
    onRunStatus?: (status: RunStatus) => void;
    onError: (err: Error) => void;
}

// ============ 1. 启动 Run ============

function startRun(
    baseUrl: string,
    body: { session_id: string; text: string; client_request_id: string },
): Promise<{ run_id: string; status: string; created: boolean }> {
    return fetchJson(`${baseUrl}/api/v2/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then((resp) => resp.data);
}

// ============ 2. 订阅事件 ============

function subscribeEvents(
    baseUrl: string,
    runId: string,
    afterSequence: number,
    cbs: RunCallbacks,
    onLastSequence: (seq: number) => void,
): AbortController {
    const controller = new AbortController();
    const url = new URL(`/api/v2/agent/run/${runId}/events`, baseUrl);
    url.searchParams.set('after_sequence', String(afterSequence));

    const req = http.request(
        {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET',
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
        },
        (res) => {
            if (res.statusCode !== 200) {
                cbs.onError(new Error(`订阅事件返回状态码 ${res.statusCode}`));
                return;
            }
            let buffer = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk: string) => {
                buffer += chunk;
                let idx: number;
                while ((idx = buffer.indexOf('\n\n')) >= 0) {
                    const block = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    handleSseBlock(block, cbs, onLastSequence);
                }
            });
            res.on('end', () => {
                if (buffer.trim()) handleSseBlock(buffer, cbs, onLastSequence);
            });
        },
    );
    req.on('error', (err) => {
        if (err.name !== 'AbortError') cbs.onError(err);
    });
    req.end();
    return controller;
}

function handleSseBlock(
    block: string,
    cbs: RunCallbacks,
    onLastSequence: (seq: number) => void,
): void {
    for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;
        try {
            const envelope: RunEventEnvelope = JSON.parse(jsonStr);
            // 只用持久事件的 sequence 更新游标（content 的 sequence 为 null，跳过）
            if (envelope.sequence !== null) {
                onLastSequence(envelope.sequence);
            }
            const { type, data } = envelope.payload;
            switch (type) {
                case 'content':
                    if (typeof data === 'string') cbs.onContent(data);
                    break;
                case 'thought':
                    if (typeof data === 'string') cbs.onThought?.(data);
                    break;
                case 'tool_start':
                    if (typeof data === 'object') cbs.onToolStart?.(data as any);
                    break;
                case 'tool_end':
                    if (typeof data === 'object') cbs.onToolEnd?.(data as any);
                    break;
                case 'tool_call':
                    if (Array.isArray(data)) cbs.onToolCall?.(data as ToolCallPayload[]);
                    break;
                case 'run_status':
                    if (typeof data === 'object') {
                        const status = (data as any).status as RunStatus;
                        cbs.onRunStatus?.(status);
                    }
                    break;
            }
        } catch {
            // 非 JSON 行，忽略
        }
    }
}

// ============ 3. 提交工具结果 ============

function submitToolResult(
    baseUrl: string,
    runId: string,
    results: ToolCallResult[],
): Promise<{ run_id: string; status: string }> {
    return fetchJson(`${baseUrl}/api/v2/agent/run/${runId}/tool-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results }),
    }).then((resp) => resp.data);
}

// ============ 4. 查询状态 ============

function getRunStatus(
    baseUrl: string,
    runId: string,
): Promise<{ run_id: string; session_id: string; status: RunStatus; last_sequence: number }> {
    return fetchJson(`${baseUrl}/api/v2/agent/run/${runId}`).then((resp) => resp.data);
}

// ============ 完整对话流程 ============

async function runConversation(
    baseUrl: string,
    sessionId: string,
    text: string,
    clientRequestId: string,
    cbs: RunCallbacks,
    executeLocalTool: (payload: ToolCallPayload) => Promise<ToolCallResult>,
): Promise<void> {
    // 1. 启动 Run
    const admission = await startRun(baseUrl, {
        session_id: sessionId,
        text,
        client_request_id: clientRequestId,
    });
    const runId = admission.run_id;
    let lastSequence = 0;

    // 2. 订阅事件（循环处理 tool_call）
    while (true) {
        const toolCalls: ToolCallPayload[] = [];
        await new Promise<void>((resolve, reject) => {
            const controller = subscribeEvents(
                baseUrl,
                runId,
                lastSequence,
                {
                    ...cbs,
                    onToolCall: (payloads) => {
                        toolCalls.push(...payloads);
                    },
                    onRunStatus: (status) => {
                        cbs.onRunStatus?.(status);
                        if (TERMINAL_STATUSES.has(status)) {
                            // 终态，订阅自然结束
                        }
                    },
                },
                (seq) => {
                    lastSequence = seq;
                },
            );
            // 监听 SSE 结束（res.on('end') 后 resolve）
            // 实际实现中需要在 res.on('end') 回调里 resolve
            setTimeout(() => {
                controller.abort();
                resolve();
            }, 1000 * 60 * 5); // 超时保护
        }).catch(reject);

        // 3. 无 tool_call 则对话结束
        if (toolCalls.length === 0) break;

        // 4. 执行本地工具（并行）
        const results = await Promise.all(toolCalls.map(executeLocalTool));

        // 5. 提交工具结果
        await submitToolResult(baseUrl, runId, results);

        // 6. 重新订阅事件（续流），after_sequence 用当前 lastSequence
    }
}

// ============ 工具函数 ============

function fetchJson(url: string, options: http.RequestOptions & { body?: string } = {}): Promise<{ success: boolean; data: any }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? require('https') : http;
        const req = lib.request(
            {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: options.method || 'GET',
                headers: { ...options.headers },
            },
            (res: http.IncomingMessage) => {
                let data = '';
                res.setEncoding('utf-8');
                res.on('data', (chunk: string) => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`JSON 解析失败: ${data}`));
                    }
                });
            },
        );
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}
```

---

## 13. 边界情况

| 场景 | 行为 |
|------|------|
| `sequence` 为 null | `content` 事件是瞬态事件（内存广播，不落库），sequence 固定为 null；插件端断线重连游标只追踪持久事件的 sequence |
| `tool_call_id` 为 null | 某些 LangGraph 版本可能不返回此字段，插件端应兼容 null |
| `input` 为空对象 | 无参数的云端工具（如 `skills_list`）input 为 `{}` |
| `output` 非 JSON | 云端工具输出可能是纯文本，不一定是 JSON 字符串 |
| 工具执行出错 | 云端工具错误信息作为 `output` 返回（`tool_end` 仍会推送）；本地工具错误用 `status: "error"` 回传 |
| 并行工具调用 | 多个 `tool_start` 可能连续推送（云端工具），各自有独立 `run_id` 分别配对；本地工具 `tool_call` 的 data 是数组，需批量回传 |
| `require_approval=true` | 非 read 权限的本地工具，插件应弹出用户确认 UI；用户拒绝则回传 `status: "cancelled"` |
| 重复提交 tool-result | 服务端幂等返回已接受回执，不重复续算（返回 JSON 非 SSE） |
| `result` 内容冲突 | 同一 `call_id` 提交不同 `result` 内容（hash 不一致），返回错误 |
| 工具结果超长 | 服务端会话级字符预算：超 20000 字符自动裁剪（头尾切片），超 10000 字符仅告警 |
| Run 终态后订阅 | `completed`/`failed`/`cancelled` 后 SSE 立即结束，不再有新事件 |
| 启动后立即订阅 | Run 初始状态为 `pending`，事件订阅会等待 `running` 状态后开始推送事件 |
| 断线重连后 content 重建 | Run 已 `completed` 时重连，content 从 `InvokeMessage` 归档文本一次性推送为单个完整文本事件（非逐 chunk）；`interrupted` 状态不重建 content |
| 进程重启丢失 content chunk | 后台任务在内存中，进程重启后 Run 标记为 `failed`，已持久化的事件不丢，content chunk 丢失但完整文本已归档 |

---

## 14. 接口清单速查

| 方法 | 路径 | 请求 | 响应 | 说明 |
|------|------|------|------|------|
| POST | `/api/agent/invoke/session` | JSON Body | JSON | 创建会话（沿用旧端点） |
| POST | `/api/v2/agent/run` | JSON Body | JSON | 启动 Run，返回 run_id |
| GET | `/api/v2/agent/run/{run_id}` | - | JSON | 查询 Run 状态和 last_sequence |
| GET | `/api/v2/agent/run/{run_id}/events` | Query: after_sequence | SSE | 订阅事件（带 sequence 信封） |
| POST | `/api/v2/agent/run/{run_id}/tool-result` | JSON Body | JSON | 提交工具结果，触发续算 |

---

## 15. 版本变更记录

| 版本 | 变更 |
|------|------|
| v2.1（当前） | **content chunk 性能优化**：`content` 事件的 `sequence` 改为 `null`（瞬态事件，走内存广播不落库）；断线重连时 content 从 `InvokeMessage` 归档文本重建（单个完整文本事件）；`after_sequence` 游标只追踪持久事件 |
| v2.0 | 计算与订阅分离；`tool_call` 的 data 为数组支持并行工具；`require_approval` 根据 permissions 动态计算；工具结果改为批量 `results[]`；新增 `sequence` 游标与断线重连；新增 `run_status` 事件；新增状态查询端点 |
| v1（旧版） | `message/stream` + `tool_result` 耦合式 SSE；`tool_call` 单个 object；`require_approval` 固定 false；单结果回传；无断线重连 |

---

## 16. 插件端迁移指南（v2.0 -> v2.1）

### 背景

v2.0 中所有 SSE 事件（包括高频的 `content` token chunk）都持久化到数据库，每个 chunk 走一次完整 DB 事务（10-40ms），几百个 chunk 累计 3-12 秒延迟。v2.1 将 `content` chunk 改为内存广播，延迟降至微秒级。

### 必须修改的部分

#### 1. `sequence` 类型从 `number` 改为 `number | null`

```typescript
// v2.0
interface RunEventEnvelope {
    sequence: number;
    ...
}

// v2.1
interface RunEventEnvelope {
    sequence: number | null;  // content 事件为 null
    ...
}
```

#### 2. 断线重连游标只追踪持久事件

`content` 事件的 `sequence` 为 `null`，不应更新 `lastSequence` 游标：

```typescript
// v2.1 正确写法
const envelope: RunEventEnvelope = JSON.parse(jsonStr);
if (envelope.sequence !== null) {
    lastSequence = envelope.sequence;  // 只用持久事件更新游标
}
// content 事件仍然正常处理
if (envelope.payload.type === 'content') {
    onContent(envelope.payload.data);
}
```

#### 3. 断线重连后 content 可能是完整文本

Run 已 `completed` 时断线重连，服务端从 `InvokeMessage` 归档文本一次性推送**单个完整 content 事件**（而非几百个逐 chunk 事件）。插件端的 content 拼接逻辑无需改动（仍是 `payload.data` 累加），但需注意：

- 重连后收到的 content 事件 `data` 可能是很长的完整文本（而非短小的 token 片段）
- 该事件的 `sequence` 仍为 `null`

### 不需要修改的部分

| 部分 | 原因 |
|------|------|
| SSE 解析逻辑 | 仍按 `payload.type` 分发，content 的 payload 结构不变 |
| content 拼接逻辑 | 仍是 `payload.data` 累加 |
| tool_call / tool_start / tool_end 处理 | 完全不变，sequence 仍为整数 |
| 断线重连流程 | `GET /{run_id}/events?after_sequence=N` 调用方式不变 |
| 提交工具结果 | 请求体格式不变 |
| 创建会话 | 不变 |

### 常见问题：流式输出不显示内容

**原因**：插件端可能用 `sequence` 作为事件过滤条件，`sequence: null` 被跳过或报错。

**排查**：
1. 检查 SSE 解析是否对 `sequence === null` 的事件做了特殊处理（如跳过、报错）
2. 检查 TypeScript 类型定义是否仍为 `sequence: number`（应改为 `number | null`）
3. 确认 `onContent` 回调被正确调用（content 事件的 `payload.type` 仍为 `"content"`）

**修复示例**：

```typescript
// 错误：sequence 为 null 时被跳过
if (envelope.sequence === null) return;  // <-- 删掉这行

// 正确：sequence 为 null 的是 content 事件，正常处理
const { type, data } = envelope.payload;
if (type === 'content' && typeof data === 'string') {
    onContent(data);  // 正常推送
}
```
