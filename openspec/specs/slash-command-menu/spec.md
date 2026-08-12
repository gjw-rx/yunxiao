# slash-command-menu Specification

## Purpose
TBD - created by archiving change slash-menu-and-claude-integration. Update Purpose after archive.
## Requirements
### Requirement: 斜杠触发分组命令菜单

聊天输入框输入 `/` 时，系统 SHALL 弹出命令选择菜单并展示三个固定分组：`基础功能`、`子智能体`、`SKILL与命令`。分组 SHALL 按序排列，未命中任何命令的分组 SHALL 显示为空态或不渲染。再次输入其他字符时 SHALL 按命令名/描述过滤候选。

#### Scenario: 输入斜杠弹出菜单

- **WHEN** 用户在聊天输入框输入 `/`
- **THEN** 弹出命令选择菜单，展示「基础功能」「子智能体」「SKILL与命令」三个分组及各自命令候选

#### Scenario: 空分组不阻塞菜单

- **WHEN** 当前无任何子智能体命令，且用户输入 `/`
- **THEN** 菜单仍展示「基础功能」与「SKILL与命令」分组，「子智能体」分组显示为空

### Requirement: 命令数据由扩展侧推送并可主动拉取

扩展侧 SHALL 通过 `postMessage({command: 'slashCommands', payload: {groups}})` 向 webview 推送分组命令数据；webview 初始化完成 SHALL 主动发送 `requestSlashCommands` 消息拉取最新数据（应对 webview 重建后的数据丢失）。命令数据的 `groups` 由三个来源组装：内置基础命令表（常量）、`skillRegistry` 中 `type === 'agent'` 的 skill（子智能体）、其余 skill 含斜杠命令（SKILL与命令）。

#### Scenario: webview 初始化拉取命令

- **WHEN** webview 完成加载并发送 `requestSlashCommands`
- **THEN** 扩展侧返回 `slashCommands` 消息，payload 包含按分组组织的全部命令候选

#### Scenario: 扩展侧推送更新

- **WHEN** skill 注册发生变化（如开启同步CLAUDE配置后加载新 skill）
- **THEN** 扩展侧重新推送 `slashCommands`，webview 更新菜单候选

### Requirement: 键盘导航与选中行为

菜单 SHALL 支持 ↑/↓ 在命令间移动焦点、Enter 选中、Esc 关闭菜单。选中命令时：基础功能命令 `send` 为 true 的 SHALL 直接发送对应消息（如 `sendMessage` 或对应命令消息）；skill 命令（子智能体 / SKILL与命令分组）SHALL 禁止直接发起会话，改为在对话框输入区生成 Skill 引用块（chip，带入场动画，可移除、可重复添加不同 Skill），由用户确认后随消息发送。其余命令 SHALL 将命令文本回填输入框并聚焦，由用户编辑后发送。选中后菜单 SHALL 关闭。

#### Scenario: 基础功能命令回车直接发送

- **WHEN** 用户选中 `send: true` 的基础功能命令并按 Enter
- **THEN** 菜单关闭，直接触发对应的消息发送（如发送命令文本到会话）

#### Scenario: 选中 skill 命令生成引用块

- **WHEN** 用户选中子智能体或 SKILL与命令分组中的 skill 命令并按 Enter
- **THEN** 菜单关闭，对话框输入区生成该 Skill 的引用块（chip，带入场动画），会话消息不被发送；发送时引用块随消息一起提交为斜杠命令文本（如 `/plan`）

#### Scenario: 回填输入框

- **WHEN** 用户选中 `send: false` 的命令并按 Enter
- **THEN** 菜单关闭，命令文本回填输入框且输入框保持聚焦，会话消息不被发送

#### Scenario: Esc 关闭菜单

- **WHEN** 菜单打开时用户按 Esc
- **THEN** 菜单关闭，输入框内容保持不变

### Requirement: 基础功能内置 /model 切换模型命令
系统 SHALL 在基础功能命令表中包含 `model` 命令（命令词 `model`，动作 `switchModel`，展示名「切换模型」）。选中该命令 SHALL 触发扩展侧模型切换动作（弹出模型选择列表），SHALL NOT 向会话发送命令消息，SHALL NOT 将命令文本回填输入框。

#### Scenario: 选中 /model 触发模型切换动作
- **WHEN** 用户在命令菜单选中「切换模型」并按 Enter
- **THEN** 菜单关闭，扩展侧弹出模型选择列表，且不向会话发送任何消息

#### Scenario: 输入 /model 触发模型切换动作
- **WHEN** 用户输入 `/model` 并在命令菜单中回车选中该命令
- **THEN** 命令菜单关闭，扩展侧弹出模型选择列表，输入框不残留 `/model` 文本

### Requirement: 基础功能菜单提供 /compact
系统 SHALL 在基础功能命令表中提供命令词 `compact`、动作 `compactContext`、展示名“压缩上下文”的命令。选择该命令 SHALL 直接触发宿主压缩动作，不得发送命令文本到会话。

#### Scenario: 从菜单选择 /compact
- **WHEN** 用户在斜杠菜单选择“压缩上下文”
- **THEN** 菜单关闭，宿主收到压缩请求，输入框不保留 `/compact` 文本

