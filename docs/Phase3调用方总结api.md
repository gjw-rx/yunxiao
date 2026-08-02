# Phase 3 调用方 API 总结 -- 批量工具调用协议

> 配套文档：`Phase3改动计划.md`（云端整体计划）
> 适用版本：批量 interrupt 协议落地后（`stream_protocol.py` / `schemas.py` / `service.py` / `views.py` 已改为批量）
> 背景：LLM 一次响应可并行发起多个本地工具调用（如同时读 10 个文件），旧协议一次只下发 1 个 tool_call、要求调用方逐个回传，导致剩余工具被反复重执行、日志爆炸、连接池耗尽。新协议一次下发全部、调用方并行执行后一次性批量回传。

---

## 一、变更概览（调用方必须同步的两点）

| 变更点 | 旧协议 | 新协议 | 影响 |
| --- | --- | --- | --- |
| `tool_call` 事件 `data` | 单个对象 `{call_id, tool, args, ...}` | **数组** `[{call_id, tool, args, ...}, ...]` | 解析逻辑改为遍历数组 |
| POST `/tool_result` body | `call_id / status / result / error` 单组字段 | `results: [{call_id, status, result, error}, ...]` 列表 | 一次回传全部结果 |

> 其余接口（`/session`、`/message/stream`、`/history`、`local_tools` 上报、SSE 行格式 `data: {json}\n\n`）**均不变**。

---

## 二、`tool_call` 事件 -- data 由对象改为数组

### 2.1 事件格式

SSE 流仍以 JSON 行协议下发：`data: {"type":"tool_call","data":[...]}\n\n`

`data` 字段由单个对象改为**对象数组**，一次包含本轮全部 pending 本地工具调用：

```json
{
  "type": "tool_call",
  "data": [
    {
      "call_id": "f8f99947e79a4be7982fc189a6a2e8c5",
      "tool": "fs.read_file",
      "args": {"path": "src/extension.ts"},
      "site": "local",
      "require_approval": false
    },
    {
      "call_id": "f9db15832fbe4ef7aac6d59e50cf3624",
      "tool": "fs.read_file",
      "args": {"path": "src/utils.ts"},
      "site": "local",
      "require_approval": false
    },
    {
      "call_id": "45acaeaeebe84410b547bdbc9303a49d",
      "tool": "code.get_diagnostics",
      "args": {"file": "src/extension.ts"},
      "site": "local",
      "require_approval": false
    }
  ]
}
```

### 2.2 字段说明（数组每个元素，与旧版单个对象一致）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `call_id` | string | 工具调用唯一 ID（uuid4 hex），回传结果时按此匹配 |
| `tool` | string | 工具名，如 `fs.read_file` / `code.get_diagnostics` |
| `args` | object | LLM 生成的工具参数，经 `args_schema` 校验后透传 |
| `site` | string | 固定 `"local"`（本地工具） |
| `require_approval` | bool | `read` 权限工具为 `false`；`write/destructive/execute` 为 `true` |

### 2.3 调用方处理要点

1. **解析 `data` 为数组**：不再当作单个对象
2. **并行执行**：数组内工具互相独立，可并行调用本地工具执行器（如 `fs.read_file` + `code.get_diagnostics` 同时跑）
3. **审批**：`require_approval=true` 的工具照常弹窗审批（单个工具独立审批，不阻塞其他工具）
4. **结果收集**：每个工具执行完得到 `{call_id, status, result, error}`，收集成列表
5. **一次回传**：执行完全部工具后，发一次 POST `/tool_result` 批量回传（见第三节）

> 注意：SSE 流在 `tool_call` 事件后**自然结束**（与旧协议一致），等调用方回传结果后续流。

---

## 三、POST `/api/agent/invoke/tool_result` -- 批量回传

### 3.1 请求体（新）

```json
{
  "session_id": "edb6212f7d224cf8a1567cbe76d588f0",
  "results": [
    {
      "call_id": "f8f99947e79a4be7982fc189a6a2e8c5",
      "status": "success",
      "result": "文件内容..."
    },
    {
      "call_id": "f9db15832fbe4ef7aac6d59e50cf3624",
      "status": "success",
      "result": "文件内容..."
    },
    {
      "call_id": "45acaeaeebe84410b547bdbc9303a49d",
      "status": "error",
      "error": "诊断服务未就绪"
    }
  ],
  "metadata": null
}
```

### 3.2 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | string | 会话 ID（= LangGraph thread_id） |
| `results` | array | **全部**工具执行结果，每个元素对应 `tool_call` 事件数组里的一个 `call_id` |
| `results[].call_id` | string | 对应 `tool_call` 事件里的 `call_id` |
| `results[].status` | string | `"success"` / `"error"` / `"cancelled"` |
| `results[].result` | string \| null | `status=success` 时的工具结果（结构化 JSON 字符串，见 `Phase3改动计划.md` 3.2 节） |
| `results[].error` | string \| null | `status=error` 时的错误信息；`status=cancelled` 时为拒绝原因 |
| `metadata` | object \| null | 可选，Phase 3 仅 `duration_ms`（只读工具不产生 `diff`/`affected_files`） |

### 3.3 status 映射（与旧版一致）

| status | 云端行为 |
| --- | --- |
| `success` | `result` 作为 `ToolMessage.content` 注入 |
| `error` | `error` 作为 `ToolMessage.content` 注入 |
| `cancelled` | `"用户拒绝了该工具调用：{error or 'cancelled'}"` 作为 `ToolMessage.content` 注入 |

> 云端按 `call_id` 匹配全部 pending interrupt，用 `Command(resume={interrupt_id: ToolMessage, ...})` 一次性续流。**调用方不需要关心 interrupt_id**，只需按 `call_id` 回传结果。

### 3.4 响应（SSE 续流）

响应仍是 SSE 流，格式与 `/message/stream` 一致：

```
data: {"type":"content","data":"分析完成，整体代码风格..."}\n\n
```

可能的事件类型：
- `content`：LLM 流式回复的文本片段
- `thought`：中间轮思维链（LLM 又决定调工具时）
- `tool_start` / `tool_end`：云端工具执行（非本地工具）
- `tool_call`：**再次**检测到本地工具 interrupt（data 仍是数组），调用方按同样逻辑处理

### 3.5 续流闭环

一次会话可能出现多轮 `tool_call` <-> `/tool_result` 往返：

```
1. POST /message/stream -> SSE 流 -> 末尾 tool_call（数组，N 个工具）
2. POST /tool_result   -> SSE 流 -> 末尾 tool_call（数组，M 个工具）
3. POST /tool_result   -> SSE 流 -> 末尾 tool_call（数组，K 个工具）
4. POST /tool_result   -> SSE 流 -> 结束（无 tool_call）
```

调用方循环处理直到 SSE 流不再出现 `tool_call` 事件为止。

---

## 四、完整调用流程示例（10 个文件批量读取）

### 4.1 会话创建（不变）

```http
POST /api/agent/invoke/session
{
  "agent_id": "a1",
  "local_tools": [
    {"name":"fs.read_file","description":"...","parameters":{...},"permissions":"read","site":"local"},
    {"name":"code.get_diagnostics","description":"...","parameters":{...},"permissions":"read","site":"local"}
  ]
}
```

响应：`{"success":true,"data":{"session_id":"edb6...","agent_id":"a1"}}`

### 4.2 发消息（SSE 流，末尾收到批量 tool_call）

```http
POST /api/agent/invoke/message/stream
{"session_id":"edb6...","text":"看下整体代码风格"}
```

SSE 流：
```
data: {"type":"thought","data":"我来读取关键文件分析代码风格"}\n\n
data: {"type":"tool_call","data":[
  {"call_id":"c1","tool":"fs.read_file","args":{"path":"src/extension.ts"},"site":"local","require_approval":false},
  {"call_id":"c2","tool":"fs.read_file","args":{"path":"src/utils.ts"},"site":"local","require_approval":false},
  {"call_id":"c3","tool":"fs.read_file","args":{"path":"src/auth.ts"},"site":"local","require_approval":false}
]}\n\n
```

### 4.3 批量回传结果（一次 POST）

调用方并行读取 3 个文件后，一次回传：

```http
POST /api/agent/invoke/tool_result
{
  "session_id":"edb6...",
  "results":[
    {"call_id":"c1","status":"success","result":"import * as vscode ..."},
    {"call_id":"c2","status":"success","result":"export function foo() ..."},
    {"call_id":"c3","status":"success","result":"export class Auth ..."}
  ]
}
```

SSE 响应：
```
data: {"type":"content","data":"整体代码风格遵循..."}\n\n
```

（无 `tool_call` 事件 -> 流程结束）

---

## 五、调用方代码改造指引

### 5.1 tool_call 解析（伪代码）

```typescript
// 旧
const toolCall = JSON.parse(line).data;          // 单个对象
await executeAndReport(toolCall.call_id, toolCall.tool, toolCall.args);

// 新
const toolCalls = JSON.parse(line).data;          // 数组
const results = await Promise.all(
  toolCalls.map(tc => executeTool(tc.call_id, tc.tool, tc.args))
);
await postToolResult(sessionId, results);
```

### 5.2 /tool_result 请求体构造（伪代码）

```typescript
// 旧
const body = { session_id, call_id, status, result, error };

// 新
const body = {
  session_id,
  results: toolCalls.map(tc => ({
    call_id: tc.call_id,
    status: tc.status,     // success / error / cancelled
    result: tc.result,
    error: tc.error,
  })),
};
```

### 5.3 续流循环（伪代码）

```typescript
async function handleStream(response: Response, sessionId: string) {
  for await (const line of parseSSE(response)) {
    const { type, data } = JSON.parse(line);
    if (type === "tool_call") {
      // data 是数组，并行执行后批量回传
      const results = await Promise.all(
        data.map(tc => executeTool(tc.call_id, tc.tool, tc.args))
      );
      // 递归处理续流（可能再次出现 tool_call）
      await postAndHandleResult(sessionId, results);
      return;
    }
    // 处理 content / thought / tool_start / tool_end
  }
}
```

---

## 六、常见问题

### 6.1 旧协议客户端访问新后端会怎样？

- `tool_call` 事件：`data` 是数组，旧客户端当对象解析会读不到 `call_id`/`tool` 字段 -> 报错或静默失败
- `/tool_result`：旧 body 没有 `results` 字段 -> Pydantic 校验失败，返回 422

**必须同步升级调用方。**

### 6.2 如果 LLM 只调 1 个工具，data 还是数组吗？

是。`data` 始终是数组，单工具时长度为 1。调用方统一按数组处理即可，无需分支。

### 6.3 部分工具执行失败怎么办？

在 `results` 数组里对失败工具填 `status:"error"` + `error` 字段，其他工具正常填 `status:"success"`。云端会把错误信息作为 `ToolMessage.content` 注入给 LLM，LLM 据此决定是否重试或改换策略。

### 6.4 用户拒绝了某个工具（审批拒绝）

对该工具填 `status:"cancelled"` + `error:"用户拒绝原因"`，其他工具照常回传。云端注入 `"用户拒绝了该工具调用：{error}"` 给 LLM。

### 6.5 批量回传时 call_id 顺序有要求吗？

无要求。云端按 `call_id` 匹配 pending interrupt，与 `results` 数组顺序无关。但建议与 `tool_call` 事件数组顺序保持一致，便于日志排查。
