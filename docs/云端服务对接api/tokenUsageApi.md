# Token 用量对接文档

> 面向 VSCode 插件侧。对话结束后，插件可通过 `run_status=completed` 事件 payload 获取本轮 token 消耗与模型最大输入长度，用于渲染消耗比例。
> 本功能是对 [Run 接口（v2）](runApi.md) §5.6 `run_status` 事件的扩展，不新增独立端点。

---

## 1. 功能概述

每次对话（Run）完成后，`run_status=completed` 事件的 payload 会携带本轮 token 消耗信息：

- **token_usage**：本轮所有 LLM 调用（含思考、工具调用 loop、最终输出）的 token 累加值
- **input_length**：当前会话使用的模型最大输入长度

插件据此渲染消耗比例：`token_usage.total_tokens / input_length`。

```
插件                          云端 Agent                           LLM
 │  订阅 Run 事件 SSE              │                                 │
 │ <─SSE: content/thought─────────│  LLM 流式输出（每次调用产出 token） │
 │ <─SSE: tool_start/tool_end─────│  云端工具执行                     │
 │ <─SSE: tool_call───────────────│  本地工具 interrupt               │
 │  [SSE 结束，执行本地工具]        │                                 │
 │  POST tool-result, 重新订阅     │                                 │
 │ <─SSE: content (最终回复)───────│  LLM 基于工具结果生成回复          │
 │ <─SSE: run_status(completed)───│  流结束，payload 含 token_usage   │
 │  [SSE 结束]                    │                                 │
 │  从 completed 事件提取 token_usage + input_length，渲染比例条     │
```

---

## 2. 数据来源

| 字段 | 来源 | 说明 |
|------|------|------|
| `token_usage.prompt_tokens` | LLM `usage_metadata.input_tokens` | 本轮所有 LLM 调用的 prompt token 累加（每次调用含完整历史消息） |
| `token_usage.completion_tokens` | LLM `usage_metadata.output_tokens` | 本轮所有 LLM 调用的 completion token 累加 |
| `token_usage.total_tokens` | LLM `usage_metadata.total_tokens` | 本轮所有 LLM 调用的总 token 累加 |
| `input_length` | Agent 配置 `ChatModelConfig.input_length` | 模型最大输入上下文长度（如 128000） |

> **累加语义**：一次 Run 可能有多次 LLM 调用（思考轮 + 工具调用轮 + 最终输出轮），每次调用的 token 用量分别累加。prompt_tokens 包含历史消息，因此累加值会随对话轮次增长。

---

## 3. run_status=completed 事件结构

### 3.1 正常完成（含 token 用量）

```json
{
  "sequence": 6,
  "event_type": "run_status",
  "payload": {
    "type": "run_status",
    "data": {
      "run_id": "run_abc123",
      "session_id": "a1b2c3...",
      "status": "completed",
      "token_usage": {
        "prompt_tokens": 15700,
        "completion_tokens": 2600,
        "total_tokens": 18300
      },
      "input_length": 128000
    }
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `payload.data.status` | `string` | `"completed"` |
| `payload.data.token_usage` | `object` | 本轮 token 累加（仅 completed 时存在） |
| `payload.data.token_usage.prompt_tokens` | `int` | prompt token 累加值 |
| `payload.data.token_usage.completion_tokens` | `int` | completion token 累加值 |
| `payload.data.token_usage.total_tokens` | `int` | 总 token 累加值 |
| `payload.data.input_length` | `int` | 模型最大输入长度（仅 completed 时存在） |

### 3.2 interrupted 状态（不含 token 用量）

```json
{
  "sequence": 5,
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

> **interrupted 时不带 token_usage 和 input_length**：中断时本轮尚未结束，token 数据不完整。续算完成后 `completed` 事件才会携带。

### 3.3 token 用量不可用

部分模型/provider 不返回 `usage_metadata`，此时 token 各字段为 `0`：

```json
{
  "token_usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  },
  "input_length": 128000
}
```

> 插件端应对 `total_tokens === 0` 做兜底处理（如显示"不可用"或隐藏比例条）。

---

## 4. 插件对接方式

### 4.1 TypeScript 类型定义

```typescript
/** token 用量（run_status=completed 时存在） */
interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

/** run_status 事件 data */
interface RunStatusData {
    run_id: string;
    session_id: string;
    status: 'pending' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
    token_usage?: TokenUsage;  // 仅 status=completed 时存在
    input_length?: number;     // 仅 status=completed 时存在
}
```

### 4.2 事件处理示例

```typescript
function handleRunStatus(data: RunStatusData): void {
    if (data.status === 'completed') {
        // completed 事件携带 token 用量
        if (data.token_usage && data.input_length) {
            const ratio = data.input_length > 0
                ? data.token_usage.total_tokens / data.input_length
                : 0;
            renderTokenUsage(data.token_usage, data.input_length, ratio);
        }
    }
    // interrupted / failed / cancelled 不携带 token_usage，无需处理
}

function renderTokenUsage(
    usage: TokenUsage,
    inputLength: number,
    ratio: number,
): void {
    // 示例：在状态栏或聊天面板底部渲染
    const percent = (ratio * 100).toFixed(1);
    const label = `本轮消耗: ${usage.total_tokens.toLocaleString()} / ${inputLength.toLocaleString()} (${percent}%)`;
    console.log(label);
    // 输出: 本轮消耗: 18,300 / 128,000 (14.3%)
}
```

### 4.3 完整订阅流程（与 runApi.md 衔接）

```typescript
// 在 runApi.md §12 的 handleSseBlock 函数中，run_status 分支扩展：
case 'run_status':
    if (typeof data === 'object') {
        const statusData = data as RunStatusData;
        cbs.onRunStatus?.(statusData.status);
        // completed 时提取 token 用量
        if (statusData.status === 'completed' && statusData.token_usage) {
            cbs.onTokenUsage?.(statusData.token_usage, statusData.input_length ?? 0);
        }
    }
    break;

// RunCallbacks 接口新增可选回调：
interface RunCallbacks {
    // ... 原有回调 ...
    onTokenUsage?: (usage: TokenUsage, inputLength: number) => void;
}
```

---

## 5. 边界情况

| 场景 | 行为 |
|------|------|
| `status` 非 `completed` | `token_usage` 和 `input_length` 字段不存在，插件不应访问 |
| 模型未返回 `usage_metadata` | `token_usage` 各字段为 `0`，`input_length` 正常返回 |
| Agent 未注册或 `input_length` 为 0 | `input_length` 为 `0`，插件应兜底（避免除零） |
| 多轮工具调用 | `token_usage` 是本轮 Run 所有 LLM 调用（含中间思考轮）的累加值 |
| 续算场景 | `interrupted` 时不带 token；续算完成后 `completed` 事件携带续算阶段的 token 累加 |
| `token_usage` 事件不广播 | `token_usage` 类型事件仅在服务端内部消费，前端 SSE 不会收到 `event_type: "token_usage"` 的事件 |

---

## 6. 渲染建议

```
┌─────────────────────────────────────────────────┐
│  对话区域                                         │
│  ...                                             │
│                                                  │
│  [AI 回复内容]                                    │
│  ...                                             │
│                                                  │
├─────────────────────────────────────────────────┤
│  本轮 Token 消耗: 18,300 / 128,000 (14.3%)       │
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  14%    │
│  prompt: 15,700 | completion: 2,600             │
└─────────────────────────────────────────────────┘
```

- 比例条：`total_tokens / input_length`
- 明细：`prompt_tokens`（输入）+ `completion_tokens`（输出）
- `input_length === 0` 或 `total_tokens === 0` 时隐藏比例条，显示"不可用"
