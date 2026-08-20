## 1. Command 文件契约与加载

- [x] 1.1 先为合法 Markdown、可选 description、非法名称/空正文、目录缺失和无工作区场景编写 Command 解析与加载测试
- [x] 1.2 新增 `src/command` 类型、解析器和双作用域加载器，以 `os.homedir()` 与第一个工作区根目录解析固定目录，并补齐文件职责、中文 JSDoc 和关键步骤 logger 日志
- [x] 1.3 为全局/项目同名覆盖、删除项目项恢复全局项编写测试并实现保留物理快照的 CommandRegistry

## 2. Command 文件管理服务

- [x] 2.1 先为全局/项目创建、编辑、删除、非法名称越界、无工作区禁用和部分无效文件容错编写存储服务测试
- [x] 2.2 实现限定固定目录的 Command CRUD、目录按需创建与安全路径校验，保证失败不修改作用域外文件且日志不输出正文
- [x] 2.3 实现串行 reload 协调：激活、CRUD 成功和手动刷新后产生同一份注册表/物理作用域快照，并用并发操作测试验证顺序一致性

## 3. 扩展装配与 Webview 协议

- [x] 3.1 扩展 Webview/Host 协议类型，加入显式斜杠候选 kind、Command 引用、双作用域设置快照及 create/update/delete/refresh 消息，并更新协议类型测试
- [x] 3.2 在 `extension.ts` 和 `chatPanel.ts` 装配 CommandRegistry 与管理服务，实现激活加载、设置消息处理、成功后刷新设置快照和斜杠菜单，并补齐关键分支中文日志
- [x] 3.3 先编写宿主消息测试，再实现发送时重新解析 Command、缺失时拒绝发送、按边界拼接正文/可选补充说明，并验证 Webview 传入正文不会被信任或执行

## 4. 斜杠菜单与聊天引用交互

- [x] 4.1 更新 `buildSlashCommandGroups` 单元测试与实现，将候选按“基础功能/命令/子智能体/SKILL”排序，并标记显式 kind 和 Command 生效来源
- [x] 4.2 先补充 MessageInput/Picker 测试，再实现 Command 选择生成 chip、不自动发送、保留补充文字、移除引用及选择另一 Command 时替换旧引用
- [x] 4.3 更新 App 消息组装和用户可见消息展示，使一个 Command 引用与现有文件/Skill 引用可共同提交且不破坏内置命令动作

## 5. 设置页 Command 管理界面

- [x] 5.1 先为新增“命令”导航项、全局/项目标签、目录/空状态、无工作区禁用和操作反馈编写 SettingsPage 测试
- [x] 5.2 在 Skill 与 MCP 之间实现命令分类，复用现有主题 token 呈现作用域标签、刷新/创建按钮、命令列表和截图所示的信息层级
- [x] 5.3 实现创建/编辑表单与删除确认，接入 Host CRUD 消息，并验证成功刷新列表、被项目覆盖标记和失败后草稿保留

## 6. 集成验证

- [x] 6.1 增加端到端宿主/Webview 场景：设置页创建全局 Command、项目同名覆盖、聊天选择后补充文字并发送最新项目正文
- [x] 6.2 运行相关 Host 单元测试与 Webview Vitest，修复所有回归并确认现有 Skill 引用、基础命令和设置分类行为保持通过
- [x] 6.3 运行 `npm run compile`（类型检查、lint、esbuild）并检查变更代码均具备中文注释/JSDoc、统一 logger 日志且未引入新依赖
