# plugin-configuration-management Specification

## Purpose
在扩展私有持久化存储中安全管理模型配置（非敏感字段存 globalState、API Key 存 SecretStorage），并向设置 Webview 提供读取与更新接口。模型配置不再通过 `yunxiaoAgent.model.*` VS Code 配置项读写。

## Requirements

### Requirement: 插件私有模型配置存储
系统 SHALL 将 Provider、模型名、Base URL、温度、最大输出 token、最大上下文 token 和运行时保存至插件私有持久化状态，并将 API Key 保存至 VS Code SecretStorage。最大上下文 token 的默认值 SHALL 为 `262144`，且用户 SHALL 能在模型配置页手动填写。系统 SHALL NOT 从或写入 `yunxiaoAgent.model.*` VS Code 配置项。

#### Scenario: 读取已保存模型配置
- **WHEN** 扩展激活且私有存储中存在模型配置
- **THEN** Provider 和 AgentLoop 使用该配置初始化，AgentLoop 使用模型的最大上下文 token，且 API Key 仅从 SecretStorage 读取

#### Scenario: 无已保存配置或旧档案缺少最大上下文字段
- **WHEN** 扩展激活且私有存储中不存在模型配置，或已有档案缺少最大上下文 token
- **THEN** 系统使用定义的安全默认值初始化，并为最大上下文 token 使用 `262144`，且不读取 `yunxiaoAgent.model.*`

### Requirement: 安全的模型配置页面协议
设置 Webview SHALL 能请求模型配置的非敏感字段和 API Key 已配置状态，并能提交经宿主验证的更新。宿主 MUST NOT 在任何消息、日志或页面状态中返回 API Key 明文。

#### Scenario: 设置页面加载模型配置
- **WHEN** 用户打开设置页面
- **THEN** 页面显示已保存的非敏感模型字段与 API Key 已配置状态，不显示 API Key 明文

#### Scenario: 保存模型配置
- **WHEN** 用户提交通过验证的模型字段和可选的新 API Key
- **THEN** 宿主持久化非敏感字段，并仅在新 API Key 非空时更新 SecretStorage 中的密钥，然后向页面返回成功状态

#### Scenario: 拒绝无效模型配置
- **WHEN** 用户提交缺失模型名或超出允许范围的数值字段
- **THEN** 宿主拒绝保存并向页面返回可显示的校验错误，既有配置保持不变

### Requirement: 压缩参数由 VSCode 原生设置管理
系统 SHALL 仅通过 VSCode 原生设置 `yunxiaoAgent.compaction.autoEnabled`、`yunxiaoAgent.compaction.triggerPercent` 和 `yunxiaoAgent.compaction.tailPercent` 管理自动压缩开关与比例。插件模型配置 Webview SHALL NOT 显示或保存这些压缩参数。

#### Scenario: 修改原生自动压缩设置
- **WHEN** 用户在 VSCode Settings 修改任一 `yunxiaoAgent.compaction.*` 新设置
- **THEN** 后续 AgentLoop 请求 SHALL 使用更新后的设置

### Requirement: 插件私有 MCP 非敏感配置存储
系统 SHALL 将版本、revision、Server ID、Transport、enabled、command/args/cwd、URL、超时、legacy SSE fallback、env key 列表和 header name 列表保存到用户级插件私有配置文件。系统 MUST NOT 从或写入项目 `.mcp.json`，也 MUST NOT 把 env/header 值写入普通文件。写入 SHALL 使用临时文件与原子替换，失败时保留上一份有效文档。

#### Scenario: 保存 MCP Server
- **WHEN** 用户通过设置页保存合法 STDIO 和远程配置
- **THEN** 非敏感字段写入私有版本化文档且 revision 递增

#### Scenario: 普通文件不含秘密
- **WHEN** STDIO env 和远程 Authorization header 已配置
- **THEN** `servers.json` 只包含 key/name 列表，不包含值

#### Scenario: 不读取项目 MCP 文件
- **WHEN** 工作区根存在 `.mcp.json` 但私有 MCP Store 为空
- **THEN** 设置页和运行时仍显示无配置，项目文件不会被导入或连接

#### Scenario: 原子写失败
- **WHEN** 新配置写入临时文件或替换失败
- **THEN** Store 返回错误且下一次读取仍得到旧有效文档

### Requirement: MCP Secrets 分离存储
系统 SHALL 将每个 STDIO env 值和远程 header 值保存至 VS Code SecretStorage，key SHALL 由 Server ID、秘密类型和字段名的稳定标识生成。删除 Server 或删除字段时 SHALL 删除对应 Secret。Host MUST NOT 向 Webview、日志或状态视图返回秘密明文。

#### Scenario: 保存新秘密
- **WHEN** JSON 含新的 env/header 非空值
- **THEN** Host 将值保存至 SecretStorage 并只向 Webview 返回已配置状态

#### Scenario: 删除秘密字段
- **WHEN** 编辑 JSON 删除已有 header
- **THEN** Host 删除对应 SecretStorage key 且持久化文档不再列出该 header

#### Scenario: 删除 Server 清理秘密
- **WHEN** 用户确认删除 MCP Server
- **THEN** Store 删除该 Server 的所有 env/header Secrets

### Requirement: MCP 秘密占位编辑语义
设置页编辑现有 Server 时 SHALL 用固定 `<已安全保存>` 占位值替代每个已配置 env/header 值。Host SHALL 将未修改占位解释为保留旧 Secret，将新的非空字符串解释为替换，将删除 key 解释为删除。新 Server 或无既有 Secret 的字段 MUST NOT 使用占位值。

#### Scenario: 保留已有 Secret
- **WHEN** 用户编辑其他字段且 env 值保持 `<已安全保存>`
- **THEN** Host 保留原 SecretStorage 值

#### Scenario: 替换已有 Secret
- **WHEN** 用户把占位替换为新字符串
- **THEN** Host 更新 SecretStorage 且 Webview 随后仍只看到占位

#### Scenario: 新配置伪造占位
- **WHEN** 新 Server JSON 使用 `<已安全保存>` 但不存在旧 Secret
- **THEN** Host 拒绝保存并返回对应字段错误

### Requirement: MCP 配置事务一致性
Store SHALL 对批量新增、单项编辑、enabled 更新与删除执行事务式验证和串行写入。配置文档和 SecretStorage 更新失败时 SHALL 尽最大可能回滚本次 Secret 变化并 MUST NOT 向 Manager 发布新 revision。

#### Scenario: 批量新增一个 Secret 写失败
- **WHEN** 两个 Server 批量导入期间一个 SecretStorage 写入失败
- **THEN** Store 不发布新配置 revision，并清理本事务已经创建的新 Secret

#### Scenario: 保存成功后应用运行时
- **WHEN** Store 完成文档与 Secrets 写入
- **THEN** Extension Host 才向 Manager 发布新 revision 并向 Webview确认保存成功
