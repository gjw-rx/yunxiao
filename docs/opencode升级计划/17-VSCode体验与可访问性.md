# VSCode 体验、运行时间线与测试

## 云效现状

Chat Webview 已支持流式文本、thought、plan、progress、工具状态、审批卡片和基础动效；但逻辑、HTML、CSS、协议处理集中在一个大型文件，缺少 reduced-motion、虚拟化和真实 Webview E2E。

## OpenCode 做得好

OpenCode 的 UI 建立在结构化 session parts 之上，工具状态、patch、使用量与错误可由同一事实模型驱动，而不是从聊天文本推断。

## 差距

云效 UI 很难在断线后精确恢复，也难清晰显示 run/step、预算、工件、冲突和文件变更；长会话可能造成渲染和状态管理压力。

## 建议落点与验收

拆分协议适配、run store 和渲染层。添加 timeline、折叠工具详情、patch 链接、重连/预算状态、ARIA live status 与 `prefers-reduced-motion`；用 `@vscode/test-electron` 覆盖审批、取消、冲突和恢复流程。
