# 代码理解与 LSP

## 云效现状

云效直接调用 VSCode Diagnostics、Workspace Symbols、Definition 和 References。这是 IDE 插件形态的优势，能复用用户已经启动的语言服务。

## OpenCode 做得好

OpenCode 自建 LSP client/server 生命周期，为非 VSCode 的 CLI、桌面和 Web 客户端统一提供语言能力，并把 LSP 工具纳入统一权限、会话与失败模型。

## 差距

云效的代码智能没有和 run 事件、文件版本、上下文预算或恢复语义关联；同一任务中诊断与编辑之间的因果关系无法形成可审计链条。

## 建议落点与验收

保留 VSCode 原生 API，不需要复制 OpenCode LSP 实现。为 LSP 结果附带文件版本和 run/step 归属；编辑后自动标记受影响诊断失效，并验证模型不会使用过期位置。
