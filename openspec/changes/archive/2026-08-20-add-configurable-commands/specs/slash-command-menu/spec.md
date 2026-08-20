## MODIFIED Requirements

### Requirement: 斜杠触发分组命令菜单

聊天输入框输入 `/` 时，系统 SHALL 弹出命令选择菜单并依次展示四个固定分组：`基础功能`、`命令`、`子智能体`、`SKILL`。未命中任何命令的分组 SHALL 显示为空态或不渲染。再次输入其他字符时 SHALL 按命令名、展示名或描述过滤候选。

#### Scenario: 输入斜杠弹出菜单

- **WHEN** 用户在聊天输入框输入 `/`
- **THEN** 弹出命令选择菜单，按顺序展示「基础功能」「命令」「子智能体」「SKILL」分组及各自候选

#### Scenario: 空分组不阻塞菜单

- **WHEN** 当前无任何自定义 Command 或子智能体，且用户输入 `/`
- **THEN** 菜单仍展示有候选的基础功能与 SKILL，空分组显示为空态或不渲染

### Requirement: 命令数据由扩展侧推送并可主动拉取

扩展侧 SHALL 通过 `postMessage({command: 'slashCommands', payload: {groups}})` 向 webview 推送分组命令数据；webview 初始化完成 SHALL 主动发送 `requestSlashCommands` 消息拉取最新数据。命令数据的 `groups` SHALL 由内置基础命令表、有效 `CommandRegistry`、`skillRegistry` 中 `type === 'agent'` 的 Skill 及其余 Skill 四类来源组装，并为每个候选提供显式类型。

#### Scenario: webview 初始化拉取命令

- **WHEN** webview 完成加载并发送 `requestSlashCommands`
- **THEN** 扩展侧返回 `slashCommands` 消息，payload 包含按四类分组组织的全部有效候选

#### Scenario: 扩展侧推送 Skill 更新

- **WHEN** Skill 注册发生变化
- **THEN** 扩展侧重新推送 `slashCommands`，webview 更新子智能体与 SKILL 候选

#### Scenario: 扩展侧推送 Command 更新

- **WHEN** Command 注册表完成创建、编辑、删除或刷新后的重载
- **THEN** 扩展侧重新推送 `slashCommands`，webview 更新命令候选及其当前生效来源

### Requirement: 键盘导航与选中行为

菜单 SHALL 支持 ↑/↓ 在命令间移动焦点、Enter 选中、Esc 关闭菜单。基础功能 SHALL 保持对应宿主动作或发送语义；Skill 与子智能体 SHALL 生成可移除的 Skill 引用块；自定义 Command SHALL 生成可移除的 Command 引用块、保持输入框可编辑且不立即发送，每条消息最多保留一个 Command 引用，选择其他 Command SHALL 替换原引用。其余 `send: false` 候选 SHALL 回填输入框。选中后菜单 SHALL 关闭。

#### Scenario: 基础功能命令回车直接执行

- **WHEN** 用户选中带宿主动作或 `send: true` 的基础功能命令并按 Enter
- **THEN** 菜单关闭并执行该基础功能的既有行为

#### Scenario: 选中 Skill 生成引用块

- **WHEN** 用户选中子智能体或 SKILL 分组中的候选并按 Enter
- **THEN** 菜单关闭并生成可移除的 Skill 引用块，会话消息不被发送

#### Scenario: 选中 Command 后补充文字

- **WHEN** 用户选中命令分组中的候选并继续输入普通文字
- **THEN** 菜单关闭并生成 Command 引用块，普通文字保留为可编辑的补充说明且会话消息不被自动发送

#### Scenario: 替换已选 Command

- **WHEN** 输入区已有 Command 引用且用户选择另一个 Command
- **THEN** 新 Command 引用替换旧引用，普通补充文字保持不变

#### Scenario: 回填输入框

- **WHEN** 用户选中 `send: false` 且不是 Skill 或 Command 引用的候选并按 Enter
- **THEN** 菜单关闭，命令文本回填输入框且输入框保持聚焦，会话消息不被发送

#### Scenario: Esc 关闭菜单

- **WHEN** 菜单打开时用户按 Esc
- **THEN** 菜单关闭，输入框内容和已有引用保持不变
