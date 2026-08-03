# 云端工具（Cloud Tool）对接文档

> 面向 VSCode 插件侧。云端工具在服务端执行，插件端通过 SSE 事件感知其调用过程（工具名、入参、输出），
> 无需执行也无需回传结果。与[本地工具](./localTool.md)不同，云端工具的执行完全由服务端完成。

---

## 1. 机制概述

```
插件                              云端 Agent (LangGraph)                     LLM
 │  POST /message/stream              │                                         │
 │  "列出可用技能"                     │                                         │
 │ ──────────────────────────────────>│                                         │
 │ <─SSE: thought────────────────────│  LLM 决策调用 skills_list                │
 │ <─SSE: tool_start (object)────────│  ToolNode 执行 skills_list               │
 │ <─SSE: tool_end (object)──────────│  工具执行完毕，回填 ToolMessage           │
 │ <─SSE: content (回复文本)──────────│  LLM 基于工具结果生成回复                 │
 │ <─SSE: [done]─────────────────────│  流结束                                  │
```

**关键特征：**
- 云端工具的执行完全在服务端完成，插件端**只读**，无需执行、无需回传。
- 插件通过 `tool_start` / `tool_end` 两个事件感知云端工具的调用过程。
- `tool_start` 和 `tool_end` 通过 `run_id` 配对，表示同一次工具调用。

---

## 2. 云端工具与本地工具的区别

| 维度 | 云端工具 | 本地工具 |
|------|----------|----------|
| 执行位置 | 服务端 | 插件端（VSCode 本地） |
| 事件类型 | `tool_start` + `tool_end` | `tool_call` |
| 插件职责 | 只读展示 | 执行 + 回传结果 |
| 典型工具 | `skills_list`、`skill_view`、`memory` | `fs.read_file`、`code.edit`、`terminal.exec` |
| data 结构 | object（含 run_id/name/input/output） | object（含 call_id/tool/args/site） |
| 配对方式 | `run_id` 配对 start/end | 无配对（单次 tool_call） |
| 结果来源 | `tool_end.data.output` | 插件本地执行后回传 `/tool_result` |

---

## 3. SSE 事件结构

### 3.1 `tool_start` 事件（云端工具开始）

```json
{
  "type": "tool_start",
  "data": {
    "run_id": "abc123-def456",
    "name": "skills_list",
    "input": {},
    "tool_call_id": "call_xxx"
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `data.run_id` | `string` | LangGraph Runnable 运行 ID，**用于配对 `tool_end`** |
| `data.name` | `string` | 云端工具名（如 `skills_list`、`skill_view`、`memory`） |
| `data.input` | `object` | LLM 传入的工具参数（JSON dict，可能为空对象 `{}`） |
| `data.tool_call_id` | `string \| null` | LLM 层面的工具调用 ID（可能为 null） |

### 3.2 `tool_end` 事件（云端工具结束）

```json
{
  "type": "tool_end",
  "data": {
    "run_id": "abc123-def456",
    "name": "skills_list",
    "output": "{\"success\":true,\"skills\":[{\"name\":\"frontend-design\",...}]}",
    "tool_call_id": "call_xxx"
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `data.run_id` | `string` | 与对应 `tool_start` 的 `run_id` **相同** |
| `data.name` | `string` | 云端工具名 |
| `data.output` | `string` | 工具执行结果文本（ToolMessage.content 或 str(output)） |
| `data.tool_call_id` | `string \| null` | LLM 层面的工具调用 ID |

### 3.3 事件时序

一轮对话中，云端工具和本地工具可能交替出现：

```
SSE 事件流：
  thought        ← LLM 思考（有 tool_calls 时）
  tool_start     ← 云端工具 skills_list 开始
  tool_end       ← 云端工具 skills_list 结束
  thought        ← LLM 再次思考（基于工具结果决策下一步）
  tool_call      ← 本地工具 fs.read_file（需插件执行后回传）
  [流暂停，等待 /tool_result]
  [插件回传后续流...]
  content        ← LLM 最终回复
  end            ← 流结束
```

---

## 4. run_id 配对机制

`tool_start` 和 `tool_end` 通过 `run_id` 配对，表示同一次工具调用的开始和结束。

```typescript
// 插件端配对逻辑示例
const pendingTools = new Map<string, ToolStartData>(); // run_id -> tool_start data

function onToolStart(data: ToolStartData) {
    pendingTools.set(data.run_id, data);
    // 在 UI 中创建"工具调用中"卡片，展示 name + input
    showToolCard({
        runId: data.run_id,
        name: data.name,
        input: data.input,
        status: 'running'
    });
}

function onToolEnd(data: ToolEndData) {
    const start = pendingTools.get(data.run_id);
    if (start) {
        pendingTools.delete(data.run_id);
        // 更新对应卡片为"完成"状态，展示 output
        updateToolCard({
            runId: data.run_id,
            output: data.output,
            status: 'done'
        });
    }
}
```

---

## 5. 统一工具展示方案

云端工具和本地工具可以用同一套 UI 组件展示，通过 `site` 字段区分来源：

```typescript
interface ToolCallDisplay {
    id: string;           // 云端工具用 run_id，本地工具用 call_id
    name: string;         // 工具名
    input: object;        // 入参（云端: tool_start.input，本地: tool_call.args）
    output?: string;      // 输出（云端: tool_end.output，本地: 执行结果）
    site: 'cloud' | 'local';
    status: 'running' | 'done' | 'error' | 'cancelled';
}

// 云端工具 -> tool_start 创建卡片，tool_end 更新卡片
// 本地工具  -> tool_call 创建卡片，/tool_result 回传后更新卡片
```

| 来源 | 创建卡片 | 更新卡片 | output 来源 |
|------|----------|----------|-------------|
| 云端工具 | `tool_start` 事件 | `tool_end` 事件 | `tool_end.data.output` |
| 本地工具 | `tool_call` 事件 | `/tool_result` 回传后 | 插件本地执行结果 |

---

## 6. 已注册的云端工具清单

当前服务端注册的云端工具（通过 `ToolRegistry` 管理）：

| 工具名 | 工具集 | 说明 |
|--------|--------|------|
| `skills_list` | `skills` | 列出已注册的技能（Skill）清单 |
| `skill_view` | `skills` | 查看指定技能的完整内容 |
| `memory` | `memory` | 记忆存储（用户意向记忆的增删改查） |

> 云端工具清单可通过 `GET /api/agent/config` 获取 Agent 配置中的 `enabled_tools` / `toolset` 字段推断。
> 新增云端工具由服务端 `ToolProvider` + `ToolRegistry` 管理，插件端无需改动。

---

## 7. 完整 SSE 处理示例（TypeScript）

```typescript
import * as http from 'http';
import { URL } from 'url';

/** 云端工具开始事件 data */
interface ToolStartData {
    run_id: string;
    name: string;
    input: Record<string, unknown>;
    tool_call_id: string | null;
}

/** 云端工具结束事件 data */
interface ToolEndData {
    run_id: string;
    name: string;
    output: string;
    tool_call_id: string | null;
}

/** 本地工具调用 payload */
interface ToolCallPayload {
    call_id: string;
    tool: string;
    args: Record<string, unknown>;
    site: 'local';
    require_approval: boolean;
}

interface StreamCallbacks {
    onContent: (text: string) => void;
    onThought?: (text: string) => void;
    onToolStart?: (data: ToolStartData) => void;
    onToolEnd?: (data: ToolEndData) => void;
    onToolCall?: (payloads: ToolCallPayload[]) => void;
    onEnd: () => void;
    onError: (err: Error) => void;
}

function handleSseLine(block: string, cbs: StreamCallbacks): void {
    for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
            continue;
        }
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) {
            continue;
        }
        try {
            const evt = JSON.parse(jsonStr);
            switch (evt.type) {
                case 'content':
                    if (typeof evt.data === 'string') cbs.onContent(evt.data);
                    break;
                case 'thought':
                    if (typeof evt.data === 'string') cbs.onThought?.(evt.data);
                    break;
                case 'tool_start':
                    if (typeof evt.data === 'object') cbs.onToolStart?.(evt.data);
                    break;
                case 'tool_end':
                    if (typeof evt.data === 'object') cbs.onToolEnd?.(evt.data);
                    break;
                case 'tool_call':
                    if (Array.isArray(evt.data)) cbs.onToolCall?.(evt.data);
                    break;
                case 'end':
                    cbs.onEnd();
                    break;
            }
        } catch {
            // 非 JSON 行，忽略
        }
    }
}

/**
 * 流式发送消息，完整处理所有事件类型。
 */
function streamMessage(
    baseUrl: string,
    body: { session_id: string; text: string },
    cbs: StreamCallbacks
): AbortController {
    const controller = new AbortController();
    const url = new URL('/api/agent/invoke/message/stream', baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);

    const req = lib.request(
        {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Accept': 'text/event-stream',
            },
            signal: controller.signal,
        },
        (res) => {
            if (res.statusCode !== 200) {
                cbs.onError(new Error(`服务返回状态码 ${res.statusCode}`));
                return;
            }

            let buffer = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk: string) => {
                buffer += chunk;
                let idx: number;
                while ((idx = buffer.indexOf('\n\n')) >= 0) {
                    const eventBlock = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    handleSseLine(eventBlock, cbs);
                }
            });
            res.on('end', () => {
                if (buffer.trim()) {
                    handleSseLine(buffer, cbs);
                }
                cbs.onEnd();
            });
        }
    );

    req.on('error', (err) => {
        if (err.name !== 'AbortError') {
            cbs.onError(err);
        }
    });
    req.write(payload);
    req.end();

    return controller;
}
```

---

## 8. 续流中的云端工具事件

当插件回传本地工具结果（`POST /tool_result`）后，续流 SSE 中同样可能包含云端工具事件：

```
插件回传 /tool_result
    ↓
续流 SSE:
  tool_start     ← 续流中云端工具开始（格式同首条消息流）
  tool_end       ← 续流中云端工具结束
  content        ← LLM 最终回复
  [或 tool_call  ← 再次触发本地工具，需再次回传]
```

续流中的 `tool_start` / `tool_end` 格式与首条消息流完全一致，插件端无需区分首条流和续流。

---

## 9. 边界情况

| 场景 | 行为 |
|------|------|
| 本地工具的 `on_tool_start` | **被服务端抑制**，插件端不会收到本地工具的 `tool_start` 事件 |
| `tool_call_id` 为 null | 某些 LangGraph 版本可能不返回此字段，插件端应兼容 null |
| `input` 为空对象 | 无参数的工具（如 `skills_list`）input 为 `{}` |
| `output` 非 JSON | 工具输出可能是纯文本，不一定是 JSON 字符串 |
| 工具执行出错 | LangGraph 会将错误信息作为 `output` 返回（`tool_end` 仍会推送） |
| 并行工具调用 | 多个 `tool_start` 可能连续推送，各自有独立 `run_id`，分别配对 `tool_end` |

---

## 10. 版本变更记录

| 版本 | 变更 |
|------|------|
| 当前 | `tool_start`/`tool_end` 的 data 从 `string` 升级为 `object`（含 run_id/name/input/output/tool_call_id）；本地工具的 `on_tool_start` 被抑制 |
| 旧版 | `tool_start` data 为工具名字符串；`tool_end` data 为输出字符串；所有工具都会推送 `tool_start` |
