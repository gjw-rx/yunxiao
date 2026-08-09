# Change Log

All notable changes to the "yunxiao-agent" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.2] - 2026-08-11

### Changed

- 对话面板打开方式：从侧边栏改为编辑器区域打开（与 Claude Code / Codex 一致）
  - 点击侧边栏「云效 Agent」图标或命令面板执行「打开对话面板」均在编辑区创建/聚焦面板
  - 面板为单例，已打开时再次触发仅聚焦；关闭后可重新打开

## [0.1.1] - 2026-08-09

### Fixed

- 修复界面友好性 bug：
  - 重构弹窗键盘/鼠标交互，键盘选择独立于鼠标悬停不再被拉回
  - 修复新建会话后会话级 token 累计显示未清零

## [Unreleased]

- Initial release