# plugin-configuration-management Specification

## Purpose
在扩展私有持久化存储中安全管理模型配置（非敏感字段存 globalState、API Key 存 SecretStorage），并向设置 Webview 提供读取与更新接口。模型配置不再通过 `yunxiaoAgent.model.*` VS Code 配置项读写。

## Requirements

### Requirement: 插件私有模型配置存储
系统 SHALL 将 Provider、模型名、Base URL、温度、最大输出 token 和运行时保存至扩展私有持久化状态，并将 API Key 保存至 VS Code SecretStorage。系统 SHALL NOT 从或写入 `yunxiaoAgent.model.*` VS Code 配置项。

#### Scenario: 读取已保存模型配置
- **WHEN** 扩展激活且私有存储中存在模型配置
- **THEN** Provider 和 AgentLoop 使用该配置初始化，且 API Key 仅从 SecretStorage 读取

#### Scenario: 无已保存配置
- **WHEN** 扩展激活且私有存储中不存在模型配置
- **THEN** 系统使用定义的安全默认值初始化，并且不读取 `yunxiaoAgent.model.*`

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
