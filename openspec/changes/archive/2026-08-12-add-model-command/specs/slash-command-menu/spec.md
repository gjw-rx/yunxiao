## ADDED Requirements

### Requirement: 基础功能内置 /model 切换模型命令
系统 SHALL 在基础功能命令表中包含 `model` 命令（命令词 `model`，动作 `switchModel`，展示名「切换模型」）。选中该命令 SHALL 触发扩展侧模型切换动作（弹出模型选择列表），SHALL NOT 向会话发送命令消息，SHALL NOT 将命令文本回填输入框。

#### Scenario: 选中 /model 触发模型切换动作

- **WHEN** 用户在命令菜单选中「切换模型」并按 Enter
- **THEN** 菜单关闭，扩展侧弹出模型选择列表，且不向会话发送任何消息

#### Scenario: 输入 /model 触发模型切换动作

- **WHEN** 用户输入 `/model` 并在命令菜单中回车选中该命令
- **THEN** 命令菜单关闭，扩展侧弹出模型选择列表，输入框不残留 `/model` 文本
