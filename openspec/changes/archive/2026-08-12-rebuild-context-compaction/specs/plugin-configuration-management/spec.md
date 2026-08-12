## MODIFIED Requirements

### Requirement: 插件私有模型配置存储
系统 SHALL 将 Provider、模型名、Base URL、温度、最大输出 token、最大上下文 token 和运行时保存至插件私有持久化状态，并将 API Key 保存至 VS Code SecretStorage。最大上下文 token 的默认值 SHALL 为 `262144`，且用户 SHALL 能在模型配置页手动填写。系统 SHALL NOT 从或写入 `yunxiaoAgent.model.*` VS Code 配置项。

#### Scenario: 读取已保存模型配置
- **WHEN** 扩展激活且私有存储中存在模型配置
- **THEN** Provider 和 AgentLoop 使用该配置初始化，AgentLoop 使用模型的最大上下文 token，且 API Key 仅从 SecretStorage 读取

#### Scenario: 无已保存配置或旧档案缺少最大上下文字段
- **WHEN** 扩展激活且私有存储中不存在模型配置，或已有档案缺少最大上下文 token
- **THEN** 系统使用定义的安全默认值初始化，并为最大上下文 token 使用 `262144`，且不读取 `yunxiaoAgent.model.*`

### Requirement: 压缩参数由 VSCode 原生设置管理
系统 SHALL 仅通过 VSCode 原生设置 `yunxiaoAgent.compaction.autoEnabled`、`yunxiaoAgent.compaction.triggerPercent` 和 `yunxiaoAgent.compaction.tailPercent` 管理自动压缩开关与比例。插件模型配置 Webview SHALL NOT 显示或保存这些压缩参数。

#### Scenario: 修改原生自动压缩设置
- **WHEN** 用户在 VSCode Settings 修改任一 `yunxiaoAgent.compaction.*` 新设置
- **THEN** 后续 AgentLoop 请求 SHALL 使用更新后的设置
