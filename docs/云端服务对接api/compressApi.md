# 手动上下文压缩 API（前端对接文档）

> 对应后端：`app/api/compress/views.py`
> 路由前缀：`/api/compress`
> 标签：`compress`

面向前端的主动压缩接口说明。前端可对指定会话发起一次手动上下文压缩，复用后端既有的 4 阶段压缩算法，压缩结果通过 LangGraph `aupdate_state` 写回 checkpointer，同时经 WebSocket 推送进度与完成事件。

---

## 1. 通用约定

### 1.1 Base URL

```
http://{host}:{port}/api/compress
```

### 1.2 请求格式

| 接口 | 方法 | 入参位置 | Content-Type |
|---|---|---|---|
| `/sessions/{session_id}/compress` | POST | Path | - |

- 该接口无请求体，`session_id` 通过路径参数传递。
- 调用前需先经 `POST /api/agent/invoke/session` 创建会话拿到 `session_id`（见 `invokeApi.md`）。

### 1.3 统一响应

所有接口返回统一信封：

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

### 1.4 错误码与触发场景

| 触发场景 | error 文案 | 说明 |
|---|---|---|
| 会话不存在 | `会话不存在: {session_id}` | `session_id` 未在 `InvokeSession` 表中找到 |
| 会话正在执行 | `会话正在执行，无法压缩: {session_id}` | session 处于 `running_sessions` 中，或存在未终态 Run（`pending`/`running`/`interrupted`），须等 Run 终态后再触发 |
| 会话消息为空 | `会话消息为空: {session_id}` | LangGraph checkpointer 中该 thread 无消息快照 |
| 压缩排队超时 | `压缩操作排队超时: {session_id}` | per-session 锁等待超过 30 秒 |

> 以上错误均返回 `{"success": false, "error": "..."}`，HTTP 状态码视全局异常处理器而定（通常 200 + `success:false`）。

---

## 2. 触发流程

```
1. POST /api/agent/invoke/session       -> 拿到 session_id（见 invokeApi.md）
2. 多轮流对话，累积上下文：
   - v1：POST /api/agent/invoke/message/stream
   - v2（VSCode 插件）：POST /api/v2/agent/run -> GET /api/v2/agent/run/{run_id}/events（见 runApi.md）
3. POST /api/compress/sessions/{session_id}/compress  -> 主动压缩当前会话上下文（须在 Run 终态后调用）
4. 继续发消息时，agent 读到的已是含摘要的收缩历史
```

- `session_id` 复用对话接口返回的凭证，无需新建。
- 压缩**写回 checkpointer**，对后续所有 `message/stream` 调用生效。
- 压缩期间该 session 被 per-session 锁串行化，不会与自动压缩或并发手动压缩冲突。

---

## 3. 接口详解

### 3.1 手动触发压缩

`POST /api/compress/sessions/{session_id}/compress`

对指定 session 执行一次上下文压缩。内部调用既有 `ContextCompressor` 的 4 阶段算法（工具输出净化 → 边界划分 → 结构化摘要 → 消息组装），通过 LangGraph `aupdate_state` + `RemoveMessage` 写回。

#### 3.1.1 请求

**Path 参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | 是 | 会话 ID（= LangGraph `thread_id`，来自 `/api/agent/invoke/session`） |

**Headers**

```
Content-Type: application/json
```

> 接口无 Body，`session_id` 仅走路径。

#### 3.1.2 响应

```json
{
  "success": true,
  "message": "success",
  "data": {
    "session_id": "8a3f...hex",
    "compressed": true,
    "before_count": 24,
    "after_count": 6,
    "pruned_count": 3,
    "summary_token_budget": 2048,
    "compress_count": 2,
    "trigger": "manual"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.session_id` | string | 回显会话 ID |
| `data.compressed` | bool | 是否实际执行了压缩。`false` 表示消息数不足以触发（≤ `protect_first_n + protect_last_n + 1`）或摘要阶段跳过 |
| `data.before_count` | int | 压缩前消息数 |
| `data.after_count` | int | 压缩后消息数（未压缩时等于 `before_count`） |
| `data.pruned_count` | int | Phase 1 工具输出净化计数 |
| `data.summary_token_budget` | int | 摘要 token 预算上限 |
| `data.compress_count` | int | 该会话累计手动压缩**成功**次数（仅 `compressed=true` 时递增） |
| `data.trigger` | string | 触发方式，固定为 `"manual"` |

#### 3.1.3 行为说明

- **空闲门控**：session 处于活跃 invoke（在 `running_sessions` 中）或存在未终态 Run（`pending`/`running`/`interrupted`）时拒绝，返回 `会话正在执行` 错误。调用方应在 Run 达到终态（`completed`/`failed`/`cancelled`）后再触发；`interrupted` 状态（等待工具结果）同样不可压缩。
- **per-session 锁**：同一 session 的压缩请求串行执行，排队超时 30s 报 `压缩操作排队超时`。
- **消息不足保护**：当消息数 ≤ `protect_first_n + protect_last_n + 1`（默认 `3 + 20 + 1 = 24`）时不压缩，返回 `compressed=false` 且 `before_count == after_count`，不调用摘要 LLM。
- **二次摘要**：手动压缩后下一轮自动压缩读到的是「含摘要的收缩历史」，再触发即在摘要上再摘要。此副作用由 `protect_last_n`（默认 20）兜底，尾部近 N 条原始消息不被摘要，崩塌有界，前端无需特殊处理。
- **幂等性**：接口非幂等。同一 session 连续调用会持续叠加摘要并递增 `compress_count`，建议在 UI 上结合 `compress_count` 做频次提示。

---

## 4. WebSocket 事件

手动压缩过程中，后端通过 `EventBus` 向所有已连接的 `/ws` 客户端广播以下事件（事件结构与现有批处理/抓包事件一致）：

> **适用范围**：WebSocket 事件面向前端 Web UI（`/ws` 连接）。VSCode 插件不消费后端 WebSocket，仅依赖 HTTP 响应做结果展示（见 §8）。

### 4.1 连接

```
ws://{host}:{port}/ws
```

连接后无需订阅，所有压缩事件会自动推送。客户端可发 `{"action": "ping"}` 做心跳，服务端回 `{"type": "pong"}`。

### 4.2 事件类型

每个事件为一个 JSON 对象，`type` 字段区分事件种类：

| type | 触发时机 | 用途 |
|---|---|---|
| `compress.started` | 压缩开始 | 显示「压缩中」loading |
| `compress.phase` | 压缩阶段推进（当前仅 `phase=completed`） | 可选展示阶段进度 |
| `compress.completed` | 压缩结束 | 更新消息数显示、关闭 loading |

### 4.3 事件载荷

#### `compress.started`

```json
{
  "type": "compress.started",
  "session_id": "8a3f...hex",
  "trigger": "manual",
  "before_count": 24
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 固定 `"compress.started"` |
| `session_id` | string | 会话 ID |
| `trigger` | string | 固定 `"manual"` |
| `before_count` | int | 压缩前消息数 |

#### `compress.phase`

```json
{
  "type": "compress.phase",
  "session_id": "8a3f...hex",
  "trigger": "manual",
  "phase": "completed",
  "pruned_count": 3,
  "summary_generated": true
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 固定 `"compress.phase"` |
| `session_id` | string | 会话 ID |
| `trigger` | string | 固定 `"manual"` |
| `phase` | string | 当前阶段，目前仅推送 `"completed"`（4 阶段一次性聚合） |
| `pruned_count` | int | Phase 1 净化计数 |
| `summary_generated` | bool | 是否成功生成摘要 |

#### `compress.completed`

```json
{
  "type": "compress.completed",
  "session_id": "8a3f...hex",
  "trigger": "manual",
  "before_count": 24,
  "after_count": 6,
  "pruned_count": 3,
  "summary_token_budget": 2048,
  "compressed": true,
  "compress_count": 2
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 固定 `"compress.completed"` |
| `session_id` | string | 会话 ID |
| `trigger` | string | 固定 `"manual"` |
| `before_count` | int | 压缩前消息数 |
| `after_count` | int | 压缩后消息数 |
| `pruned_count` | int | Phase 1 净化计数 |
| `summary_token_budget` | int | 摘要 token 预算上限 |
| `compressed` | bool | 是否实际执行了压缩 |
| `compress_count` | int | 该会话累计手动压缩成功次数 |

> 说明：HTTP 响应与 `compress.completed` 事件载荷字段一致，前端可任选其一作为最终结果来源。HTTP 响应可靠到达后再用事件更新 UI 更稳妥。

---

## 5. 前端对接示例（fetch + WebSocket）

### 5.1 触发压缩

```ts
interface ManualCompressResponse {
  session_id: string;
  compressed: boolean;
  before_count: number;
  after_count: number;
  pruned_count: number;
  summary_token_budget: number;
  compress_count: number;
  trigger: "manual";
}

async function compressSession(
  sessionId: string,
  baseUrl = "/api/compress",
): Promise<ManualCompressResponse> {
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/compress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json.data as ManualCompressResponse;
}
```

### 5.2 监听压缩事件

```ts
type CompressEvent =
  | {
      type: "compress.started";
      session_id: string;
      trigger: "manual";
      before_count: number;
    }
  | {
      type: "compress.phase";
      session_id: string;
      trigger: "manual";
      phase: "completed";
      pruned_count: number;
      summary_generated: boolean;
    }
  | {
      type: "compress.completed";
      session_id: string;
      trigger: "manual";
      before_count: number;
      after_count: number;
      pruned_count: number;
      summary_token_budget: number;
      compressed: boolean;
      compress_count: number;
    };

interface CompressHandlers {
  onStarted?: (e: Extract<CompressEvent, { type: "compress.started" }>) => void;
  onPhase?: (e: Extract<CompressEvent, { type: "compress.phase" }>) => void;
  onCompleted?: (
    e: Extract<CompressEvent, { type: "compress.completed" }>,
  ) => void;
}

function connectCompressWebSocket(
  handlers: CompressHandlers,
  wsUrl = "ws://localhost:8000/ws",
): WebSocket {
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    if (!msg.type.startsWith("compress.")) return; // 其他域事件忽略

    switch (msg.type) {
      case "compress.started":
        handlers.onStarted?.(msg);
        break;
      case "compress.phase":
        handlers.onPhase?.(msg);
        break;
      case "compress.completed":
        handlers.onCompleted?.(msg);
        break;
    }
  };

  return ws;
}
```

### 5.3 使用示例

```ts
const ws = connectCompressWebSocket({
  onStarted: (e) => console.log("[压缩开始]", e.before_count),
  onPhase: (e) => console.log("[阶段完成]", e.phase, e.pruned_count),
  onCompleted: (e) =>
    console.log(
      "[压缩完成]",
      e.before_count,
      "→",
      e.after_count,
      `累计=${e.compress_count}`,
    ),
});

// 触发压缩
try {
  const result = await compressSession(sessionId);
  console.log("[HTTP 响应]", result.compressed, result.compress_count);
} catch (err) {
  console.error("[压缩失败]", err);
}
```

---

## 6. 事件速查表

| 事件 type | 关键字段 | 含义 |
|---|---|---|
| `compress.started` | `before_count` | 压缩开始，显示 loading |
| `compress.phase` | `phase`, `pruned_count`, `summary_generated` | 阶段进度（当前仅 `completed`） |
| `compress.completed` | `before_count`, `after_count`, `compress_count`, `compressed` | 压缩完成，更新 UI |

---

## 7. 常见问题

**Q1：`session_id` 从哪里来？**
必须先调 `POST /api/agent/invoke/session` 创建，返回的 `data.session_id` 即为凭证，复用同一 session_id 调本接口。

**Q2：能否在对话流进行中调用压缩？**
不能。session 活跃时返回 `会话正在执行，无法压缩`。前端应在 `/message/stream` 流结束后（`reader.read()` 返回 `done:true`）再触发。

**Q3：`compressed=false` 是什么情况？**
消息数不足以触发压缩（≤ `protect_first_n + protect_last_n + 1`，默认 24 条）或摘要阶段返回 None。此时 `before_count == after_count`，`compress_count` 不递增，前端无需提示失败，按"当前无需压缩"处理即可。

**Q4：压缩后历史查询返回什么？**
压缩写回 checkpointer，后续 `GET /api/agent/invoke/history` 返回的是归档表内容（不变）。agent 读到的 LangGraph 内存中的消息列表才是收缩后的版本，两者不同步——历史查询面向展示，checkpointer 面向 agent 记忆。

**Q5：多次手动压缩会叠加吗？**
会。每次成功压缩都会在摘要上再摘要，`compress_count` 持续递增。建议前端在 UI 上展示 `compress_count`，并对频繁手动压缩做适度提示。

**Q6：HTTP 响应和 WebSocket 事件用哪个？**
两者字段一致。推荐：HTTP 响应作为权威结果（用于业务判断），WebSocket 事件用于实时 UI 反馈（loading/进度）。事件可能在 HTTP 响应之前或之后到达，前端应容忍乱序。

---

## 8. VSCode 插件对接

VSCode 插件（`sdks/yunxiao-agent/`）走 v2 Run API + SSE 订阅，**不连接后端 WebSocket**（`/ws`）。插件集成上下文压缩能力时，仅需对接 HTTP 接口，不消费 §4 描述的 WebSocket 事件。

### 8.1 对接路径

```
1. POST /api/agent/invoke/session          -> 创建会话，拿 session_id
2. POST /api/v2/agent/run                  -> 启动 Run，拿 run_id
3. GET  /api/v2/agent/run/{run_id}/events  -> SSE 订阅 Run 事件
4. 收到 run_status(completed/failed/cancelled) -> Run 终态，SSE 结束
5. POST /api/compress/sessions/{session_id}/compress -> 主动压缩（HTTP 同步）
6. 继续发消息时，agent 读到的已是含摘要的收缩历史
```

### 8.2 触发时机

**必须在 Run 达到终态后调用**。插件通过 SSE 收到 `run_status` 事件且 `status` 为 `completed`/`failed`/`cancelled` 时，表示 Run 已终态，方可触发压缩。

- **不可在 `interrupted` 状态压缩**：Run 等待本地工具结果（`interrupted`）时 SSE 流虽已结束，但 LangGraph 图仍持有 interrupt 状态，此时压缩会与后续 `resume` 产生 checkpointer 写冲突。后端已对未终态 Run 做门控拦截，返回 `会话正在执行` 错误。
- **判断方式**：以 `run_status` 事件的 `status` 字段为准，而非 SSE 流的 `onEnd`（`interrupted` 时 `onEnd` 也会触发）。

### 8.3 响应消费

插件 `aiClient.ts` 的 `request<T>` 统一解析 `ApiResponse<T>` 信封，成功返回 `data`，失败抛 `Error(error)`。压缩接口的 `data` 即 `ManualCompressResponse`：

```ts
interface ManualCompressResponse {
  session_id: string;
  compressed: boolean;
  before_count: number;
  after_count: number;
  pruned_count: number;
  summary_token_budget: number;
  compress_count: number;
  trigger: "manual";
}
```

- `compressed=false`：消息不足或摘要未生成，`compress_count` 不递增，按"当前无需压缩"处理。
- `compressed=true`：压缩成功，`compress_count` 递增，可在 UI 展示累计次数。

### 8.4 进度反馈

插件无法收到 §4 的 WebSocket 事件，压缩期间只能用 HTTP 同步等待。建议 UI 实现：

- 发起压缩时显示 loading（"压缩中..."）
- HTTP 响应到达后关闭 loading，展示 `before_count -> after_count` 收缩效果
- 压缩通常耗时数秒（含摘要 LLM 调用），`asyncio.to_thread` 已避免阻塞事件循环，但 HTTP 请求本身是同步的，插件侧应设置合理超时（建议 60s）
