## Context

当前输入区由 `MessageInput.tsx` 在模型名按钮上方展示一个平铺的 `.model-picker`，Webview 打开时发送 `requestModelPicker`，宿主从 `ModelConfigStore` 返回已启用模型，选择后通过 `selectModel` 将目标模型设为默认并重建 Provider。模型配置是全局 JSON 文档，API Key 单独保存在 `SecretStorage`。

LLM 层已经具备大部分推理基础设施：`ReasoningEffort` 包含 `low/medium/high`，`AgentLoop` 可以把 `reasoningEffort` 放入 `LLMRequest`，AI SDK 与 legacy Provider 已分别处理 OpenAI-compatible 的 reasoning effort 和 DeepSeek 的 `thinking`。缺口是配置值没有从模型档案进入 AgentLoop，也没有 Webview 交互与持久化链路。

OpenCode 的可借鉴点是把推理档位建模为模型 variant：选择状态属于模型，UI 只选择档位，Provider 层负责把档位转换为具体请求字段。当前项目没有 OpenCode 的 provider/model capability catalog，因此本次不复制其完整模型发现系统。

## Goals / Non-Goals

**Goals:**

- 把输入区模型按钮升级为符合参考图信息层级的分层配置弹层。
- 提供低、中、高三档推理强度，并按模型记忆选择。
- 复用现有 Provider 适配，保证 Webview 与 AgentLoop 不包含 provider-specific 分支。
- 保证模型或推理档位切换只影响之后启动的运行。
- 对旧模型配置保持无行为变化，并覆盖主题、键盘、协议、存储和请求参数测试。

**Non-Goals:**

- 不实现参考图中的“速度”“高级”设置。
- 不引入 models.dev 或远程模型能力目录，也不自动探测任意自定义 endpoint 是否支持推理强度。
- 不新增 `minimal`、`disabled`、`xhigh`、`max` 等用户可见档位。
- 不改变推理内容的流式展示、token 统计和会话消息格式。

## Decisions

### 1. 使用单一分层弹层，而不是并列两个下拉框

`MessageInput` 维护 `root | model | reasoning` 三个视图状态。根视图包含“模型”和“推理强度”两行，右侧显示当前值和进入箭头；子视图具有返回入口，并用单选列表展示候选项。弹层继续锚定输入工具栏并向上展开，使用 VS Code 主题 token、受视口约束的宽度和最大高度、长模型名省略、当前项勾选及轻量过渡。

该结构与参考图一致，并避免在狭窄侧边栏同时放置多个独立控件。语义上根行使用按钮，子列表使用 `menuitemradio`/`aria-checked`；Esc、点击外部和选择完成关闭，关闭后焦点回到触发按钮。流式回复期间沿用现状禁用入口。

### 2. 推理强度是模型档案的可选字段

新增共享类型 `ReasoningLevel = 'low' | 'medium' | 'high'`，并在内部模型档案与完整 `ModelConfig` 上增加可选 `reasoningEffort`。新建模型写入 `medium`；已有文档缺少字段时保持 `undefined`，读取时不得静默补写，从而维持升级前 Provider 默认行为。用户首次选择后才为该模型写入显式值。

选择属于模型而非会话：切换默认模型时，弹层和后续运行自动使用目标档案保存的值。这与 OpenCode 的 model variant 归属一致，也避免为会话存储增加另一套生命周期。

备选方案是只用 `workspaceState` 保存一个全局档位，但它会让不同模型共享可能不合适的值；另一方案是按会话保存，会增加会话归档和切换协议，超出本次需求。

### 3. 扩展现有模型弹层协议，不下发连接信息

`ModelPickerItem` 增加可选的非敏感 `reasoningEffort`，`modelInfo` 同步当前模型的展示名、模型 ID 与有效档位；新增 `selectReasoningLevel` Webview 消息，携带当前模型 ID 和三档之一。宿主必须重新校验目标模型存在、已启用且仍是当前默认模型，再调用 `ModelConfigStore.setReasoningEffort` 持久化并推送最新快照。

协议不包含 API Key、baseURL 或 Provider 私有选项。保留 `requestModelPicker`/`selectModel` 名称，以缩小现有消息链路改动；模型切换后宿主复用相同刷新路径更新模型名与推理值。

### 4. 每次运行同时快照 Provider 与生成配置

仅快照 Provider 不能保证多步工具运行期间的模型、temperature、maxTokens 和 reasoning effort 不变化，因为后续 step 仍可能读取可变的 `this.config`。`AgentLoop.run` 开始时应捕获只读的调用配置快照，运行内所有 LLM step 使用该快照；`updateModelConfig` 只更新下一次 `run` 的配置。

该选择同时兑现既有模型切换规格和新推理档位规格。推理档位更新复用扩展侧模型配置应用入口，更新 AgentLoop 配置；Provider 可按现有方式重建，但进行中运行继续持有旧 Provider 与旧调用配置。

### 5. Provider 层负责请求字段映射

AgentLoop 只传递规范化的 `low/medium/high`。AI SDK runtime 继续通过 `providerOptions['openai-compatible'].reasoningEffort` 传递；legacy runtime 继续发送 `reasoning_effort`。DeepSeek 分支同时启用 `thinking` 并省略不兼容的 temperature。不得在 Webview、ChatPanel 或 AgentLoop 中按模型名称拼装请求字段。

本次不做任意 endpoint 的能力探测。旧档案的 `undefined` 是兼容护栏；用户对某模型显式选择后，如果上游不支持该参数，沿用现有模型错误通道报告，不静默降级，以免界面显示的档位与实际请求不一致。

### 6. 测试按数据流分层

- Webview 测试覆盖根视图、两个子视图、当前项、选择消息、Esc/外部关闭、焦点与流式禁用。
- reducer/protocol 测试覆盖新字段和模型切换后的当前档位刷新。
- `ModelConfigStore` 测试覆盖新建默认中档、旧文档字段缺失、按模型持久化、非法档位拒绝。
- AgentLoop 测试覆盖运行快照；AI SDK 与 legacy Provider 测试覆盖三档映射及 DeepSeek 参数。
- 宿主消息测试覆盖校验、日志、成功刷新与失败反馈；最终运行 `npm run compile` 和相关测试。

## Risks / Trade-offs

- [自定义 OpenAI-compatible endpoint 不支持 `reasoning_effort`] → 旧档案保持未设置；只有用户显式选择后发送，并让 Provider 错误明确返回，不伪造成功。
- [更新时影响进行中的多步运行] → 在 `run` 入口同时快照 Provider 与生成配置，并用并发切换测试验证所有 step 保持旧值。
- [弹层在窄侧边栏溢出或遮挡] → 使用视口约束宽度、最大高度与滚动容器，并复用现有向上弹出层级。
- [可选字段在设置页编辑时被覆盖丢失] → 编辑既有模型时由 Store 保留原 `reasoningEffort`，除非专用 setter 明确修改。
- [模型能力目录缺失导致所有模型都可选择三档] → 本期明确采用用户显式选择语义；未来若引入 capability catalog，再由宿主下发每个模型的可用 variants，UI 结构无需重写。

## Migration Plan

1. 先扩展类型与 Store 读取逻辑，保证旧 version 1 文档缺少字段时仍可加载且不回写。
2. 接通 AgentLoop 配置快照和 Provider 映射测试，再开放宿主选择消息。
3. 最后替换 Webview 弹层并补齐交互测试，避免 UI 先暴露但运行时尚未生效。
4. 回滚时可移除 UI 与新消息；可选 JSON 字段会被旧版本忽略，API Key 和其余模型字段不受影响。

## Open Questions

- 后续是否引入模型能力元数据，以便像 OpenCode 一样只展示模型实际支持的 variants；这不阻塞本次三档显式选择实现。

