## ADDED Requirements

### Requirement: 用户可为当前模型选择三档推理强度
系统 SHALL 在对话输入区的模型配置弹层中为当前模型提供“低”“中”“高”三个推理强度选项，并 MUST 分别规范化为 `low`、`medium`、`high`。系统 SHALL 清晰标记当前选中项，不得向用户展示本次范围外的推理档位。

#### Scenario: 打开推理强度子列表
- **WHEN** 用户在模型配置弹层中选择“推理强度”
- **THEN** Webview 展示低、中、高三个单选项，并标记当前模型的有效档位

#### Scenario: 选择新的推理强度
- **WHEN** 用户为当前模型选择与当前值不同的档位
- **THEN** Webview 向宿主提交当前模型 ID 与规范化档位，成功后关闭弹层并显示新档位

### Requirement: 推理强度按模型持久化且兼容旧配置
系统 SHALL 将显式选择的推理强度存储在对应模型档案中。新建模型 SHALL 默认保存 `medium`；已有模型档案缺少推理字段时 MUST 保持未设置并继续使用 Provider 原有默认行为，直至用户首次显式选择。编辑模型的其他字段 MUST 保留已有推理强度。

#### Scenario: 新建模型配置
- **WHEN** 用户保存一个此前不存在的模型档案且未提供推理强度
- **THEN** Store 为该档案保存 `medium`

#### Scenario: 读取升级前的模型配置
- **WHEN** Store 读取一个不含推理强度字段的已有模型档案
- **THEN** Store 返回未显式设置的推理状态，不补写字段，后续请求保持升级前行为

#### Scenario: 切换到已记忆档位的模型
- **WHEN** 用户从模型 A 切换到曾保存高档的模型 B
- **THEN** 弹层显示模型 B 的高档，之后启动的新运行使用 `high`

#### Scenario: 拒绝非法档位
- **WHEN** 宿主收到低、中、高之外的推理强度或目标模型不是当前已启用的默认模型
- **THEN** 宿主拒绝更新、保留原值并通过现有错误通道反馈

### Requirement: 推理强度只影响之后启动的运行
系统 SHALL 在每次 AgentLoop 运行开始时快照模型、Provider 和生成配置，包含推理强度。运行期间发生的模型或推理强度更新 MUST 仅影响之后启动的新运行，不得改变当前运行后续 step 的请求参数。

#### Scenario: 流式回复期间更新档位
- **WHEN** 一个使用低档启动的运行尚未结束，配置被更新为高档
- **THEN** 当前运行的所有后续 LLM step 继续使用低档，下一次新运行使用高档

### Requirement: Provider 将规范化档位映射为请求参数
系统 SHALL 由 LLM Provider 层把 `low`、`medium`、`high` 映射为上游请求参数，AgentLoop 与 Webview MUST 保持 provider agnostic。OpenAI-compatible 请求 SHALL 使用 reasoning effort；DeepSeek 请求 SHALL 同时启用 thinking 并遵守其 temperature 约束。未显式设置档位时 SHALL 沿用现有 Provider 默认行为。

#### Scenario: OpenAI-compatible 模型使用中档
- **WHEN** AgentLoop 以 `medium` 调用 OpenAI-compatible 模型
- **THEN** AI SDK 或 legacy Provider 在各自协议中发送等价的 medium reasoning effort

#### Scenario: DeepSeek 模型使用高档
- **WHEN** AgentLoop 以 `high` 调用 DeepSeek 模型
- **THEN** Provider 启用 DeepSeek thinking、发送 high reasoning effort，并省略不兼容的 temperature

#### Scenario: 旧模型没有显式档位
- **WHEN** AgentLoop 调用一个推理强度为未设置的旧模型档案
- **THEN** 非 DeepSeek Provider 不新增 reasoning 参数，DeepSeek 继续采用变更前的默认思考行为

### Requirement: 推理控制协议不得暴露敏感配置
宿主与 Webview 之间的推理控制消息 SHALL 只包含模型 ID、非敏感展示信息和规范化档位，MUST NOT 包含 API Key、baseURL 或 Provider 私有请求选项。

#### Scenario: 宿主同步推理状态
- **WHEN** 宿主向 Webview 发送当前模型及推理强度
- **THEN** 消息中不包含 API Key、baseURL 或原始 provider options

