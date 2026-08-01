# Agent 对话调用 API（前端对接文档）

> 对应后端：`app/api/agent/invoke/views.py`
> 路由前缀：`/api/agent/invoke`
> 标签：`agent-invoke`

面向前端的对话对接说明，**重点为流式接口 `/message/stream`**。完整闭环：创建会话 → 发流式消息 → 查历史。

---

## 1. 通用约定

### 1.1 Base URL

```
http://{host}:{port}/api/agent/invoke
```

### 1.2 请求格式

| 接口 | 方法 | 入参位置 | Content-Type |
|---|---|---|---|
| `/session` | POST | JSON Body | `application/json` |
| `/message` | POST | JSON Body | `application/json` |
| `/message/stream` | POST | JSON Body | `application/json` |
| `/history` | GET | Query | - |

### 1.3 统一响应（非流式接口）

所有非流式接口返回统一信封：

```jsonc
// 成功
{ "success": true, "message": "success", "data": { ... } }

// 失败
{ "success": false, "error": "错误描述文案" }
```

- `success`：业务是否成功（布尔）
- `data`：成功时的业务负载（失败时无此字段）
- `error`：失败时的中文错误描述（成功时无此字段）
- `message`：成功时的提示文案，默认 `"success"`

### 1.4 常见错误

| 触发场景 | 响应 |
|---|---|
| 会话不存在 | `{ "success": false, "error": "会话不存在: {session_id}" }` |
| Agent 装配失败 | `{ "success": false, "error": "Agent 装配失败: {agent_id}" }` |
| Agent 调用失败 | `{ "success": false, "error": "Agent 调用失败: {detail}" }` |
| Agent 流式调用失败 | `{ "success": false, "error": "Agent 流式调用失败: {detail}" }` |

> 注意：流式接口在 SSE 流建立**之后**发生异常时，错误以 JSON 行事件形式推送（见 4.2.5）；在流建立**之前**校验失败（如会话不存在），直接返回上述 JSON 错误信封（HTTP 状态码视全局异常处理器而定，通常 200 + `success:false` 或 400/500）。

---

## 2. 对话闭环流程

```
1. POST /session            → 拿到 session_id（= LangGraph thread_id）
2. POST /message/stream     → 用 session_id 发消息，SSE 接收回复
   （可循环多轮，session_id 复用，服务端通过 checkpointer 维持短期记忆）
3. GET  /history            → 查询该会话已归档的 user/assistant 消息
```

- `session_id` 是整条链路的唯一凭证，需前端保存。
- 服务端在每轮流式消息中自动归档 `user`（流开始前）与 `assistant`（流结束后，由 `content` 事件累积）消息。
- `thought` / `tool_start` / `tool_end` 事件仅用于前端展示，**不归档**到历史。

---

## 3. 接口详解

### 3.1 创建会话

`POST /api/agent/invoke/session`

创建对话会话，返回 `session_id`（即 LangGraph `thread_id`），并触发 agent 装配（幂等）。

**请求体**

```json
{ "agent_id": "agent_xxx" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `agent_id` | string | 是 | Agent 唯一标识 |

**响应**

```json
{
  "success": true,
  "message": "success",
  "data": { "session_id": "8a3f...hex", "agent_id": "agent_xxx" }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.session_id` | string | 会话 ID（uuid4 hex），后续接口凭证 |
| `data.agent_id` | string | 回显 agent_id |

---

### 3.2 流式发消息（重点）

`POST /api/agent/invoke/message/stream`

发送消息，以 **SSE（Server-Sent Events）** 形式返回 agent 事件流；流结束后服务端自动归档 user/assistant 消息。

#### 3.2.1 请求

**Headers**

```
Content-Type: application/json
Accept: text/event-stream
```

**Body**

```json
{ "session_id": "8a3f...hex", "text": "你好" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | 是 | 会话 ID（来自 `/session`） |
| `text` | string | 是 | 用户输入文本 |

> ⚠️ **关键约束**：本接口为 `POST + JSON Body`，浏览器原生 `EventSource` **无法**调用（`EventSource` 仅支持 GET、无法设置 body/header）。前端必须使用 `fetch` + `ReadableStream` 手动解析 SSE（见第 4 节示例）。

#### 3.2.2 响应

- `Content-Type: text/event-stream`
- 每个事件以 `data: {json_line}\n\n` 形式推送（两个 `\n` 分隔事件）。

**SSE 行结构**

```
data: {"type":"content","data":"你"}\n\n
data: {"type":"content","data":"好"}\n\n
```

其中 `{json_line}` 为紧凑 JSON：

```jsonc
{ "type": "<事件类型>", "data": "<数据>" }
```

#### 3.2.3 事件类型（type）

| type | data 含义 | 是否归档 | 前端处理建议 |
|---|---|---|---|
| `content` | 最终回复的文本 token（逐片推送） | ✅ 累积后归档为 assistant 消息 | 实时拼接到回复气泡 |
| `thought` | 中间轮（有工具调用时）的思考文本 | ❌ | 折叠展示为「思考过程」 |
| `tool_start` | 工具开始执行，data 为工具名 | ❌ | 展示「调用工具：{name}」 |
| `tool_end` | 工具执行结束，data 为工具输出 | ❌ | 折叠展示工具结果 |

**典型事件序列**

- 纯文本回复：连续多个 `content` → 流结束。
- 带工具调用：`thought` → `tool_start` → `tool_end` → … → 最终多个 `content` → 流结束。

#### 3.2.4 流结束行为

- 服务端在流 `finally` 阶段：若累积的 `content` 文本非空，自动归档为 `assistant` 消息。
- `user` 消息在 SSE 流开始**前**已归档。
- 前端无需显式调用归档接口。

#### 3.2.5 流中异常

若 agent 调用过程中抛错，服务端通过全局异常处理转为 `{ "success": false, "error": "Agent 流式调用失败: ..." }`。由于 SSE 已建立，前端在解析 `data:` 行时需兼容：

- 能 `JSON.parse` 且含 `type` 字段 → 按事件处理；
- 能 `JSON.parse` 且含 `success:false` → 视为错误事件；
- 解析失败 → 原样记录。

> 当前实现下，流建立后的异常会中断 SSE 流（连接关闭），前端可结合 `fetch` 的 `done` 状态与是否已收到完整回复判断是否异常中断。

---

### 3.3 查询历史

`GET /api/agent/invoke/history`

按 `seq` 升序返回该会话已归档的消息列表。

**Query 参数**

| 参数 | 类型 | 必填 | 默认 | 约束 | 说明 |
|---|---|---|---|---|---|
| `session_id` | string | 是 | - | - | 会话 ID |
| `offset` | int | 否 | 0 | >= 0 | 偏移量 |
| `limit` | int | 否 | 50 | 1 ~ 500 | 上限 |

**响应**

```json
{
  "success": true,
  "message": "success",
  "data": [
    {
      "id": 1,
      "session_id": "8a3f...hex",
      "role": "user",
      "content": "你好",
      "seq": 0,
      "create_time": "2026-07-24T10:00:00"
    },
    {
      "id": 2,
      "session_id": "8a3f...hex",
      "role": "assistant",
      "content": "你好，有什么可以帮你？",
      "seq": 1,
      "create_time": "2026-07-24T10:00:01"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `data[].id` | int | 消息主键 |
| `data[].session_id` | string | 会话 ID |
| `data[].role` | string | 角色：`user` / `assistant` |
| `data[].content` | string | 消息内容 |
| `data[].seq` | int | 会话内序号（从 0 递增） |
| `data[].create_time` | string | 创建时间（ISO 8601） |

---

### 3.4 非流式发消息（对照）

`POST /api/agent/invoke/message`

与流式接口语义一致，但同步返回完整回复（内部调 `agent.ainvoke`）。

**请求体**

```json
{ "session_id": "8a3f...hex", "text": "你好" }
```

**响应**

```json
{
  "success": true,
  "message": "success",
  "data": {
    "session_id": "8a3f...hex",
    "reply": "你好，有什么可以帮你？",
    "role": "assistant"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.session_id` | string | 回显会话 ID |
| `data.reply` | string | agent 完整回复 |
| `data.role` | string | 固定 `"assistant"` |

---

## 4. 前端对接示例（fetch + ReadableStream 解析 SSE）

以下为可直接用于测试的完整示例（TypeScript）。

### 4.1 创建会话

```ts
async function createSession(agentId: string, baseUrl = "/api/agent/invoke") {
  const res = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json.data.session_id as string;
}
```

### 4.2 流式发消息（核心）

```ts
type StreamEvent =
  | { type: "content"; data: string }
  | { type: "thought"; data: string }
  | { type: "tool_start"; data: string }
  | { type: "tool_end"; data: string };

interface StreamOptions {
  /** 收到 content token 时回调（实时拼回复） */
  onContent?: (delta: string) => void;
  /** 收到 thought 时回调 */
  onThought?: (text: string) => void;
  /** 工具开始 */
  onToolStart?: (toolName: string) => void;
  /** 工具结束 */
  onToolEnd?: (output: string) => void;
  /** 流中错误事件 */
  onError?: (msg: string) => void;
}

async function sendMessageStream(
  sessionId: string,
  text: string,
  opts: StreamOptions = {},
  baseUrl = "/api/agent/invoke",
): Promise<void> {
  const res = await fetch(`${baseUrl}/message/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ session_id: sessionId, text }),
  });

  // 流建立前失败（如会话不存在）：响应体是 JSON 错误信封
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const json = await res.json();
    throw new Error(json.error || "请求失败");
  }

  if (!res.body) throw new Error("浏览器不支持 ReadableStream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // SSE 以 \n\n 分隔事件，逐块解析
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    // 按事件边界切分
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const line = rawEvent.trim();
      if (!line.startsWith("data:")) continue;

      const jsonLine = line.slice(5).trim(); // 去掉 "data:" 前缀
      let parsed: any;
      try {
        parsed = JSON.parse(jsonLine);
      } catch {
        continue; // 非 JSON，忽略
      }

      // 错误信封（流中异常）
      if (parsed.success === false) {
        opts.onError?.(parsed.error || "未知错误");
        continue;
      }

      const ev = parsed as StreamEvent;
      switch (ev.type) {
        case "content":
          opts.onContent?.(ev.data);
          break;
        case "thought":
          opts.onThought?.(ev.data);
          break;
        case "tool_start":
          opts.onToolStart?.(ev.data);
          break;
        case "tool_end":
          opts.onToolEnd?.(ev.data);
          break;
      }
    }
  }
}
```

### 4.3 使用示例

```ts
const sessionId = await createSession("agent_xxx");

let reply = "";
await sendMessageStream(sessionId, "帮我查下今天的天气", {
  onContent: (delta) => {
    reply += delta;
    // 实时更新回复气泡 UI
    console.log("[回复片段]", delta);
  },
  onThought: (text) => console.log("[思考]", text),
  onToolStart: (name) => console.log("[调用工具]", name),
  onToolEnd: (out) => console.log("[工具结果]", out),
  onError: (msg) => console.error("[错误]", msg),
});

console.log("[完整回复]", reply);
```

### 4.4 查询历史

```ts
async function getHistory(
  sessionId: string,
  offset = 0,
  limit = 50,
  baseUrl = "/api/agent/invoke",
) {
  const params = new URLSearchParams({
    session_id: sessionId,
    offset: String(offset),
    limit: String(limit),
  });
  const res = await fetch(`${baseUrl}/history?${params}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json.data as Array<{
    id: number;
    session_id: string;
    role: "user" | "assistant";
    content: string;
    seq: number;
    create_time: string;
  }>;
}
```

---

## 5. SSE 事件速查表

| 事件 type | data 示例 | 含义 | 归档 |
|---|---|---|---|
| `content` | `"你"` | 最终回复 token | ✅ |
| `thought` | `"需要先查天气"` | 中间轮思考文本 | ❌ |
| `tool_start` | `"get_weather"` | 工具开始，data=工具名 | ❌ |
| `tool_end` | `"北京 28℃ 晴"` | 工具结束，data=工具输出 | ❌ |

---

## 6. 常见问题

**Q1：能否用浏览器原生 `EventSource`？**
不能。`EventSource` 仅支持 GET 且无法发送 JSON body 与自定义 header。本接口为 POST，必须用 `fetch` + `ReadableStream` 解析。

**Q2：`session_id` 从哪里来？**
必须先调 `POST /session` 创建，返回的 `data.session_id` 即为凭证，整个会话周期复用。

**Q3：多轮对话如何保持上下文？**
同一 `session_id` 多次调 `/message/stream`，服务端以 `session_id` 作为 LangGraph `thread_id`，经 checkpointer 自动维持短期记忆。前端无需重传历史。

**Q4：流式回复与历史查询的 `content` 是否一致？**
一致。流结束后服务端将所有 `content` token 拼接归档为一条 `assistant` 消息，`GET /history` 返回该完整内容。

**Q5：流中断如何判断？**
`fetch` 的 `reader.read()` 返回 `done:true` 即流结束。若结束时未收到任何 `content` 事件或收到 `success:false` 错误事件，视为异常中断。
