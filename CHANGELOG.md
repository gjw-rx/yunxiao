# Change Log

All notable changes to the "yunxiao-agent" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.0] - 2026-08-15

### Added

- 集成 MCP 工具：设置页配置本地 STDIO 或远程 Streamable HTTP Server，动态发现的工具桥接为 Function Calling，经同一审批与结果治理链执行
- 新增外部网络检索 `web_search`（Tavily）：设置页启用并配置 API Key 后可用，支持搜索深度与域名限制
- 新增 agent 生态来源：加载全局 `~/.agents/skills` 与工作区 AGENTS.md 规则
- 新增 Hooks 运行时与 RTK 终端命令优化
- 新增 diff 界面：代码编辑变更可视化预览
- 新增会话变更审查能力与任务进度工具 `todo_write`（会话内任务面板）
- 新增全访问审批模式（`full-access`）：自动批准非删除操作，删除仍需确认
- 新增对话内容删除与用户输入回滚
- 新增设置界面（模型与 Skill 配置），支持在编辑器页签打开
- 支持模型切换：composer 下拉选择与 `/model` 斜杠命令
- 聊天视图固定到右侧边栏
- 模型回复前添加思考动画
- 重建上下文自动压缩机制

### Changed

- LLM 运行时迁移至 Vercel AI SDK（OpenAI 兼容 `/v1/chat/completions` 接入方式不变）
- 全量工具名由点号命名空间改为下划线（如 `web.search` → `web_search`）
- 前端界面改用框架渲染
- 模型配置改为用户全局目录存储，自动迁移工作区旧档案

### Fixed

- 校验并归一化 AI SDK usage，修正缓存记账与展示口径
- 终端工具统一 UTF-8 输出编码
- 允许空 `fs_list_dir` 路径
- 修复对话框执行工具错误显示
- 紧凑展示模型配置列表，支持横向滚动

## [0.1.2] - 2026-08-09

### Changed

- 对话面板打开方式：从侧边栏改为编辑器区域打开（与 Claude Code / Codex 一致）
  - 点击侧边栏「云效 Agent」图标或命令面板执行「打开对话面板」均在编辑区创建/聚焦面板
  - 面板为单例，已打开时再次触发仅聚焦；关闭后可重新打开

### Added

- 新增编辑器右上角对话图标入口，可直接打开/聚焦对话面板
- 添加自动发布 workflow：推送 `v*` tag 时自动打包 .vsix 并发布 GitHub Release / VS Marketplace

### Fixed

- 修复新会话改名后输入框被误禁用的问题

## [0.1.1] - 2026-08-09

### Fixed

- 修复界面友好性 bug：
  - 重构弹窗键盘/鼠标交互，键盘选择独立于鼠标悬停不再被拉回
  - 修复新建会话后会话级 token 累计显示未清零