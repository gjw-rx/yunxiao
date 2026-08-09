# 云效 Agent — VSCode 插件

本地驱动的 AI 编程助手：直连 OpenAI 兼容的大模型服务，在 VSCode 内直接执行文件读写、代码智能、Git、终端等本地工具，内置审批网关保障操作安全。**无需部署云端 Agent 服务**。

## 功能特性

- **本地驱动** — 插件直连任意 OpenAI 兼容端点（OpenAI / DeepSeek / 通义千问 / vLLM / Ollama 等），本地完成工具执行，代码与文件不出工作区
- **本地工具执行** — 18 个内置本地工具，覆盖文件系统、代码智能、Git、终端、Diff
- **审批网关** — 写 / 执行 / 删除类操作弹审批卡片（允许 / 始终允许 / 拒绝），只读操作自动放行
- **流式对话** — SSE 流式回复、打字机效果，工具调用过程实时可视化，含每步与会话级 token 用量统计
- **多会话管理** — 新建、历史切换、重命名、删除；会话按工作区隔离本地持久化
- **上下文自动压缩** — 对话接近模型上下文窗口时自动生成摘要压缩，保留近期关键信息
- **Skill 系统** — 从 `.vscode/skills` 或 Claude / Trae 的 SKILL 目录加载技能，支持 `/skill-name` 斜杠命令
- **斜杠命令** — `/new` 新会话、`/stop` 停止生成、`/help` 帮助；输入框 `@` 引用文件自动注入上下文
- **Markdown 渲染** — 代码块、列表、链接、表格等完整渲染

## 快速开始

1. 打开 VSCode 设置，搜索「云效」，配置模型连接（见下方示例）
2. 命令面板 `Ctrl+Shift+P` → 输入「云效 Agent: 打开对话面板」（或点击活动栏「云效 Agent」图标）
3. 在输入框输入消息，`Enter` 发送，`Shift+Enter` 换行

### 模型配置示例

在 VSCode 设置（`settings.json`）中配置：

```json
{
  "yunxiaoAgent.model.baseURL": "https://api.deepseek.com/v1",
  "yunxiaoAgent.model.model": "deepseek-chat",
  "yunxiaoAgent.model.apiKey": "sk-xxxxxxxx"
}
```

不支持的 Provider 或缺失的 API Key 会在启动对话时给出明确错误提示。

## 前置条件

- VSCode **^1.99.0** 及以上
- 一个 OpenAI 兼容的 LLM 服务（`/v1/chat/completions` 端点），如 OpenAI、DeepSeek、通义千问，或本地部署的 vLLM / Ollama

## 本地工具一览

| 类别 | 工具 | 说明 | 权限 |
|------|------|------|------|
| 文件 | `fs.read_file` | 分页读取文件内容 | 只读 |
| 文件 | `fs.write_file` | 原子写入 UTF-8 文本文件 | 需审批 |
| 文件 | `fs.list_dir` | 列出目录内容 | 只读 |
| 文件 | `fs.search_files` | 按内容搜索文件（ripgrep / glob） | 只读 |
| 文件 | `fs.delete_file` | 删除文件（移入回收站） | 需审批 |
| 文件 | `fs.move_file` | 移动 / 重命名文件 | 需审批 |
| 代码 | `code.edit` | 字符串替换或 unified diff 精准编辑，带 diff 预览与冲突检测 | 需审批 |
| 代码 | `code.find_references` | 查找符号引用 | 只读 |
| 代码 | `code.get_diagnostics` | 获取文件诊断信息 | 只读 |
| 代码 | `code.go_to_definition` | 跳转到符号定义 | 只读 |
| 代码 | `code.workspace_symbols` | 搜索工作区符号 | 只读 |
| Git | `git.status` / `git.log` / `git.diff` | 仓库状态、提交历史、差异查看 | 只读 |
| Git | `git.commit` / `git.branch` / `git.stash` | 提交、分支管理、stash 操作 | 需审批 |
| 终端 | `terminal.exec` | 执行 shell 命令并捕获输出；白名单命令自动放行，危险命令需审批 | 需审批 |
| Skill | `skill` | 按名称加载 Skill，返回 Markdown 指令 | 只读 |

## 安全模型

- **路径守卫** — 所有文件操作经 `pathGuard` 校验，限定在打开的工作区内，越界读写被拒绝
- **分级审批** — 只读工具自动放行；写 / 执行 / 删除类工具弹审批卡片，提供「允许（本次会话记忆）/ 始终允许（写入配置）/ 拒绝」三选项
- **终端白名单** — `yunxiaoAgent.shellWhitelist` 前缀匹配自动放行（如 `npm test`、`git status`）；`rm -rf`、管道、重定向、`sudo` 等危险命令强制审批
- **结果治理** — 工具返回结果在发往模型前自动脱敏密钥、截断长度，避免泄露与上下文超限

## 扩展设置（常用）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `yunxiaoAgent.model.baseURL` | `https://api.openai.com/v1` | LLM API 地址（OpenAI 兼容 `/v1/chat/completions`） |
| `yunxiaoAgent.model.model` | 空 | 模型名称（如 `gpt-4o-mini`、`deepseek-chat`） |
| `yunxiaoAgent.model.apiKey` | 空 | LLM API Key（Bearer Token） |
| `yunxiaoAgent.model.temperature` | `0.7` | 生成温度 |
| `yunxiaoAgent.model.maxTokens` | `4096` | 单次最大输出 token 数 |
| `yunxiaoAgent.toolTimeoutMs` | `30000` | 本地工具执行超时（毫秒） |
| `yunxiaoAgent.terminalTimeoutMs` | `300000` | 终端命令执行超时（毫秒） |
| `yunxiaoAgent.alwaysAllowTools` | `[]` | 无需审批直接放行的工具名列表（如 `fs.write_file`） |
| `yunxiaoAgent.shellWhitelist` | 14 条安全命令前缀 | 终端自动放行的命令前缀 |
| `yunxiaoAgent.skills.directories` | `[".vscode/skills"]` | Skill 搜索目录（相对工作区根） |
| `yunxiaoAgent.sync.source` | `none` | 生态配置来源：`none` / `claude`（同步 Claude SKILL 与项目规则）/ `trae` |
| `yunxiaoAgent.agent.maxSteps` | `50` | Agent 循环最大步数 |
| `yunxiaoAgent.compaction.enabled` | `true` | 是否启用上下文自动压缩 |

更多配置项（读文件护栏、结果截断、范围授权等）可在 VSCode 设置中搜索「云效」查看。

## 安装

### 从 Open VSX 市场安装

在 VSCode 扩展面板搜索「云效 Agent」直接安装。

### 安装 .vsix 文件

```bash
code --install-extension yunxiao-agent-0.1.0.vsix
```

或在 VSCode 内：扩展面板 → 右上角 `···` → 从 VSIX 安装。

## 许可证

[MIT](LICENSE)
