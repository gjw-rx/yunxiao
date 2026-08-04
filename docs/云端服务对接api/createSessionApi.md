# Create Session API 对接说明

扩展通过创建会话接口为当前 Agent 建立独立的云端上下文。每次切换到不同 Agent（模型）时，扩展会创建新会话；已选中的同一 Agent 不会重复创建。会话创建时，扩展会同时上报本地工具声明与当前工作区根目录。

## 接口

`POST /api/agent/invoke/session`

请求体使用 JSON，`agent_id` 必填；`local_tools` 与 `workspace_root` 可选。服务端必须兼容未携带可选字段的旧版客户端。

```json
{
  "agent_id": "agent_xxx",
  "workspace_root": "D:\\python_project\\vscodePlugin\\yunxiao-agent",
  "local_tools": [
    {
      "name": "fs.read_file",
      "description": "Read a UTF-8 text file from the local workspace",
      "parameters": { "type": "object", "properties": {} },
      "permissions": "read",
      "site": "local"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `agent_id` | string | 是 | 云端 Agent 标识。服务端根据它装配模型与 Agent 配置。 |
| `workspace_root` | string | 否 | 当前 VS Code 工作区的第一个根目录的本地文件系统路径。Windows 路径会使用反斜杠。无打开工作区时不传。 |
| `local_tools` | array | 否 | 扩展端可执行的本地工具 schema；仅包含 `site: "local"` 的工具。 |

## 服务端处理要求

1. 校验 `agent_id` 并创建新的 session；同一 Agent 的不同请求也必须得到彼此独立的 session。
2. `workspace_root` 存为 session 元数据，供 Agent 理解相对路径、生成面向本地工具的指引或审计记录使用。
3. 绝不能把 `workspace_root` 当作云端容器中的可访问路径；云端不得据此读取文件、执行命令或绕过本地工具调用协议。
4. `local_tools` 存入该 session 的工具上下文，使模型知道必须通过工具调用访问本地工作区。
5. 可选字段缺失、为空或为 `null` 时必须兼容处理，不影响普通聊天会话的创建。
6. 对日志中的 `workspace_root` 做脱敏或按会话数据策略保护，避免暴露用户目录信息。

## 成功响应

返回 200，并至少包含扩展后续请求所需的 session 标识：

```json
{
  "session_id": "session_xxx",
  "agent_id": "agent_xxx"
}
```

## 错误响应

`agent_id` 无效、无权访问或请求体不合法时返回对应的 4xx 响应，并使用项目统一错误信封：

```json
{
  "success": false,
  "error": "Agent 不存在或不可用"
}
```

不要因为未知的可选字段或缺少 `workspace_root` / `local_tools` 拒绝创建会话，以保证与旧版扩展兼容。
