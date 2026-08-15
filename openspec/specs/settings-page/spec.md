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
系统 SHALL 通过扩展宿主在编辑器区域打开标题为“云效 Agent 设置”的独立 WebviewPanel 标签。聊天 Webview MUST 保持当前会话标识、已加载消息、输入草稿和已有前端状态。设置标签 SHALL 仅通过定义的模型配置与 Skill 管理消息协议向扩展宿主请求数据或写入操作。

#### Scenario: 重复打开设置标签

- **WHEN** 用户在设置标签已经打开时再次点击聊天头部的设置按钮
- **THEN** 系统聚焦已有设置标签，不创建重复标签

### Requirement: 设置分类与可操作内容
设置页 SHALL 使用左侧分类导航和右侧内容区展示“模型”“Skill”“MCP”“Hooks”“使用情况”五个分类，导航顺序 SHALL 为模型、Skill、MCP、Hooks、使用情况，默认显示“模型”。模型分类 MUST 显示可编辑的模型配置和保存状态；Skill 分类 MUST 显示已加载 Skill 并提供安装操作的状态反馈；MCP 分类 MUST 提供 JSON 配置入口与 MCP Server 列表管理；Hooks 分类 MUST 提供 Hooks 总开关与内置 RTK Hook 的配置、检测和测试反馈；使用情况内容 MUST 明确不代表真实 token、费用或账户统计。

#### Scenario: 查看并保存模型配置
- **WHEN** 用户在设置页默认的“模型”分类加载或保存有效配置
- **THEN** 页面显示宿主返回的当前非敏感字段及保存结果，且不会显示 API Key 明文

#### Scenario: 查看 Skill 管理内容
- **WHEN** 用户在设置页点击“Skill”分类
- **THEN** 页面请求并显示当前已加载 Skill，且安装反馈会更新列表或显示失败原因

#### Scenario: 查看 MCP 管理内容
- **WHEN** 用户在设置页点击“MCP”分类
- **THEN** 页面请求并显示当前 MCP Server 快照，并提供 JSON 新增/编辑、启停、重连和删除操作

#### Scenario: 查看 Hooks 管理内容
- **WHEN** 用户在设置页点击位于 MCP 下方的“Hooks”分类
- **THEN** 页面请求并显示 Hooks 总开关、RTK 启用状态、可执行文件路径、检测状态和测试改写反馈

#### Scenario: 查看使用情况占位内容
- **WHEN** 用户在设置页点击“使用情况”分类
- **THEN** 右侧显示使用情况的静态占位内容，且不会请求或显示真实 token、费用或账户数据

### Requirement: 设置页 MCP 异步状态反馈
设置页 SHALL 区分 MCP 配置保存结果、操作已接受状态和最终连接状态。MCP Server 的连接或重连 SHALL NOT 阻塞整个设置页面；Host 推送新状态时页面 SHALL 只更新相关 MCP 快照，模型与 Skill 草稿保持不变。

#### Scenario: 重连进行中
- **WHEN** 用户点击 MCP Server 重连且 Host 接受操作
- **THEN** 页面显示 reconnecting，并允许继续浏览其他设置分类

#### Scenario: 状态推送不清空模型草稿
- **WHEN** 用户正在编辑模型且 Host 推送 MCP ready 状态
- **THEN** MCP 快照更新但模型表单草稿保持不变

### Requirement: 设置页视觉层级
设置页 SHALL 采用与当前 VS Code 主题一致的克制、原生编辑器风格，并以分类侧栏、页面标题、说明文字和分组卡片/行项目建立清晰的信息层级。内容区 MUST 在可用高度内滚动，分类导航在窄 Webview 宽度下仍可访问。

#### Scenario: 在受限 Webview 空间查看设置

- **WHEN** 设置内容高度超过当前 Webview 的可视高度
- **THEN** 用户可滚动内容区查看全部静态内容，且仍可访问分类导航

### Requirement: Hooks 设置页采用精密运维面板信息架构
Hooks 设置分类 SHALL 复用设置页现有的 VS Code 主题变量、分类侧栏、字体、按钮、卡片边界和响应式滚动行为，并采用“运行状态 → 生命周期 → 已启用自动化 → 高级配置 → 安全说明”的阅读层级。页面首屏 MUST 显示 Hooks 运行状态和总开关；随后 SHALL 将 `session_start`、`pre_tool_call`、`post_tool_call`、`session_end` 呈现为连续的生命周期轨道，每个节点包含事件名称、中文说明、启用 Hook 数量与状态。第一版不得用重复的“信任/开关/展开”列表模拟大量第三方 Hook。

#### Scenario: 首屏展示 Hooks 运行态与生命周期
- **WHEN** 用户打开 Hooks 设置分类
- **THEN** 页面首先显示总运行状态和总开关，并在其后显示四个基础事件的连续生命周期轨道；有启用集成的事件节点与空节点具有可辨识但克制的状态差异

#### Scenario: 仅 RTK 启用时强调工具执行前节点
- **WHEN** RTK 是唯一启用的内置 Hook，且其事件为 `pre_tool_call`
- **THEN** 生命周期轨道将“工具执行前”显示为已启用并标注 1 个 Hook，其余三个节点显示 0 个 Hook

### Requirement: RTK 作为主自动化卡片并收纳高级配置
Hooks 页面 SHALL 将 RTK 显示为“已启用自动化”中的主集成卡片，而不是普通表单行。该卡片 MUST 显示 RTK 名称、`terminal_exec` 作用范围、启用开关、可用性/版本状态和有界错误摘要；可用状态下 SHALL 提供“原命令 → RTK rewrite → 紧凑输出”的简短过程预览。可执行文件路径、重新检测和固定 `git status` 样例测试 SHALL 位于默认折叠的“高级配置”区域；样例测试结果仅显示改写前后的命令或错误，不得执行真实 Git 命令或展示完整命令输出。

#### Scenario: RTK 可用状态展示
- **WHEN** Host 返回可用的 RTK 状态
- **THEN** 页面在 RTK 主卡片中显示启用控制、`terminal_exec` 范围、版本和检测成功状态，并在高级配置区域提供路径和测试操作

#### Scenario: RTK 不可用状态展示
- **WHEN** Host 返回 RTK 不可用或检测失败状态
- **THEN** 页面在 RTK 主卡片中显示可读且有界的错误摘要，并允许用户展开高级配置修改路径后重新检测，不影响其他设置分类草稿

#### Scenario: 测试改写成功后的反馈
- **WHEN** 用户触发固定样例测试且 Host 返回改写结果
- **THEN** 页面在 RTK 卡片内显示 `git status` 到改写命令的有界对照，并使用一次短暂的状态强调反馈成功，不展示实际执行输出

#### Scenario: 窄窗口访问 Hooks 设置
- **WHEN** Hooks 内容高度或宽度超过受限 Webview 的可视空间
- **THEN** 生命周期轨道换行或纵向排列，用户仍可滚动访问 RTK 控件和分类导航，且页面不依赖固定宽度布局

