## ADDED Requirements

### Requirement: token 账保留实际调用模型快照
AgentLoop 在每次 LLM 调用形成 token 账时 SHALL 将该次调用实际使用的 provider 标识、模型标识和当时的非敏感展示名一并写入 assistant 消息的 `tokenUsage` 快照。模型字段 SHALL 从本次运行已捕获的模型配置取得，MUST NOT 在调用完成后重新读取可能已切换的默认模型；展示名仅用于历史显示，统计分组 SHALL 使用 provider 与模型标识。模型快照不得包含 API Key、鉴权 header 或其他 Secret。

#### Scenario: 运行中切换默认模型
- **WHEN** 模型 A 的调用进行中且用户将后续默认模型切换为模型 B
- **THEN** 本次 assistant tokenUsage 仍记录模型 A，下一次以模型 B 启动的调用记录模型 B

#### Scenario: 模型配置后续重命名或删除
- **WHEN** 一笔 tokenUsage 已记录模型标识和展示名，随后对应模型配置被重命名或删除
- **THEN** 历史 token 账的模型标识和展示名保持不变，可继续用于统计和显示

#### Scenario: token 账不泄露鉴权信息
- **WHEN** 模型配置包含 API Key 或鉴权 header
- **THEN** 持久化 tokenUsage 只包含 provider、模型标识和非敏感展示名，不包含任何鉴权值

