# settings-page Specification

## Purpose
在 VS Code 编辑器区域提供云效 Agent 的独立设置标签页，用于展示模型、Skill 与使用情况的前端配置入口。

## Requirements

### Requirement: 聊天头部设置入口
系统 SHALL 在聊天 Webview 的会话操作区提供设置按钮，且该按钮的视觉顺序位于“新建会话”之后、“历史会话”之前。该按钮 MUST 具有可访问名称与提示文本。

#### Scenario: 从聊天头部打开设置标签

- **WHEN** 用户点击设置按钮
- **THEN** 编辑器区域打开独立设置标签，且不创建、删除或切换当前会话

### Requirement: 独立设置编辑器标签
系统 SHALL 通过扩展宿主在编辑器区域打开标题为“云效 Agent 设置”的独立 WebviewPanel 标签。聊天 Webview MUST 保持当前会话标识、已加载消息、输入草稿和已有前端状态，设置标签不得向扩展宿主发送配置写入或数据读取消息。

#### Scenario: 重复打开设置标签

- **WHEN** 用户在设置标签已经打开时再次点击聊天头部的设置按钮
- **THEN** 系统聚焦已有设置标签，不创建重复标签

### Requirement: 设置分类与静态内容
设置页 SHALL 使用左侧分类导航和右侧内容区展示“模型”“Skill”“使用情况”三个分类，默认显示“模型”。点击分类 SHALL 只切换右侧静态内容；模型和 Skill 内容 MUST 明确为尚未接入保存/生效逻辑的展示状态，使用情况内容 MUST 明确不代表真实 token、费用或账户统计。

#### Scenario: 查看 Skill 占位内容

- **WHEN** 用户在设置页点击“Skill”分类
- **THEN** 右侧显示 Skill 管理的静态说明或空状态，且不会修改 Skill 注册状态

#### Scenario: 查看使用情况占位内容

- **WHEN** 用户在设置页点击“使用情况”分类
- **THEN** 右侧显示使用情况的静态占位内容，且不会请求或显示真实 token、费用或账户数据

### Requirement: 设置页视觉层级
设置页 SHALL 采用与当前 VS Code 主题一致的克制、原生编辑器风格，并以分类侧栏、页面标题、说明文字和分组卡片/行项目建立清晰的信息层级。内容区 MUST 在可用高度内滚动，分类导航在窄 Webview 宽度下仍可访问。

#### Scenario: 在受限 Webview 空间查看设置

- **WHEN** 设置内容高度超过当前 Webview 的可视高度
- **THEN** 用户可滚动内容区查看全部静态内容，且仍可访问分类导航
