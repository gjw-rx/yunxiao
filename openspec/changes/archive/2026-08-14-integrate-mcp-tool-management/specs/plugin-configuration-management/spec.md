## ADDED Requirements

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

