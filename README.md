# 云效 Agent — VSCode 插件

对接自有 AI Agent 服务的 VSCode 对话面板，支持流式回复、Markdown 渲染、多 Agent 切换。

## 功能

- **多 Agent 选择** — 自动加载服务端配置的 Agent 列表
- **流式对话** — SSE 实时推送，打字机效果逐字显示回复
- **Markdown 渲染** — AI 回复支持代码块、列表、链接等格式
- **会话管理** — 新建会话、加载历史消息
- **停止生成** — 中断正在进行的流式回复
- **可配置服务地址** — Settings 中修改，无需改代码

## 使用方式

1. `Ctrl+Shift+P` → 输入 **云效 Agent: 打开对话面板**
2. 在顶部下拉框选择 Agent
3. 点击「新会话」创建对话
4. 在输入框输入消息，`Enter` 发送，`Shift+Enter` 换行

## 前置条件

- AI Agent 后端服务已启动（默认 `http://127.0.0.1:8002`）
- 后端至少装配一个 Agent

## 扩展设置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `yunxiaoAgent.serviceBaseUrl` | `http://127.0.0.1:8002` | AI 服务的 Base URL |

在 VSCode Settings 中搜索「云效」即可修改。

## 安装 .vsix

```bash
code --install-extension yunxiao-agent-0.0.1.vsix
```

或在 VSCode 内：扩展面板 → 右上角 `···` → 从 VSIX 安装。
