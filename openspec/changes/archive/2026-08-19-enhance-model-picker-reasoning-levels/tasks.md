## 1. 类型契约与模型存储

- [X] 1.1 在 LLM、模型配置和 Webview 协议中定义并复用 `low | medium | high` 推理档位类型，扩展非敏感模型快照与选择消息，并为新增导出类型和字段补齐中文注释。
- [X] 1.2 先补充 `ModelConfigStore` 测试，覆盖新模型默认中档、旧档案缺失字段不补写、编辑其他字段保留档位、非法档位/非当前模型拒绝，再实现按模型持久化 setter 与关键成功/失败日志。
- [X] 1.3 扩展模型配置到运行时的转换，使当前模型的可选推理档位进入完整 `ModelConfig`，同时确认 API Key、baseURL 和 Provider 私有参数不进入 Webview payload。

## 2. AgentLoop 与 Provider 运行语义

- [X] 2.1 先增加 AgentLoop 并发配置更新测试，再在每次 `run` 入口快照 Provider 及模型、temperature、maxTokens、reasoning effort，确保一次多步运行始终使用启动时配置。
- [X] 2.2 将推理档位接入扩展初始化和模型配置热更新链路，更新 `AgentLoop.updateModelConfig` 的类型、日志与测试，使选择只对之后启动的运行生效。
- [X] 2.3 扩充 AI SDK 与 legacy Provider 测试，验证 low/medium/high 的 OpenAI-compatible 映射、DeepSeek thinking/temperature 行为，以及未设置档位保持原有默认请求。

## 3. 宿主与 Webview 状态同步

- [X] 3.1 扩展 ChatPanel 模型弹层快照和 `selectReasoningLevel` 消息处理：重新校验模型状态、持久化选择、应用运行配置、推送最新模型/档位，并为入口、拒绝、成功和异常补齐中文日志。
- [X] 3.2 更新 ChatPanel 测试，覆盖弹层数据不含敏感字段、模型切换同步目标模型档位、有效推理选择和无效/过期请求拒绝。
- [X] 3.3 扩展 Webview reducer 与 App 属性传递以保存当前模型 ID 和推理档位，并补充 reducer 测试验证宿主刷新顺序不会产生模型名与档位错配。

## 4. 分层模型配置弹层

- [X] 4.1 先更新 `MessageInput` 组件测试，覆盖根视图、模型/推理子视图、返回、当前项、选择消息、Esc、外部点击、焦点恢复和流式禁用。
- [X] 4.2 将现有平铺模型列表重构为 `root | model | reasoning` 单弹层状态机，使用可访问的按钮与单选语义，并保持现有模型请求/选择协议兼容。
- [X] 4.3 重写弹层局部样式，使用 VS Code 主题 token 完成参考图式行布局、分隔/圆角/阴影、选中与悬停状态、向上展开、窄视口约束、长名称省略和 reduced-motion 兼容；不改动无关输入区样式。

## 5. 验证与交付

- [X] 5.1 运行并修复模型存储、ChatPanel、AgentLoop、Provider、reducer 和 `MessageInput` 相关测试，确认新增关键路径均有行为覆盖。
- [X] 5.2 运行 `npm run compile`，通过 TypeScript strict、ESLint 与 esbuild，并人工检查深色/浅色主题及窄侧边栏下的弹层布局。
- [X] 5.3 运行 `openspec validate enhance-model-picker-reasoning-levels`，确认提案、设计、规格和任务均有效且变更达到可实施状态。
