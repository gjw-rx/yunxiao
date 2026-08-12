# Hermes Agent 上下文压缩调研与本项目落地

## 调研范围

调研对象为 `docs/hermes-agent` 中 Hermes Agent 的上下文压缩实现，重点阅读其 `agent/context_compressor.py`、会话主循环中压缩调用点，以及工具调用消息规范化逻辑。本文记录可迁移的机制，而非复制 Hermes 的运行时或依赖。

## Hermes 的关键机制

1. **预算优先**：Hermes 将模型上下文长度、预留输出 token 和当前请求占用组合为可用输入预算，再使用比例阈值决定是否压缩。其小上下文场景使用 75% 作为保守触发点，避免接近 API 限制才恢复。
2. **增量检查点摘要**：压缩不是删除会话，而是把旧摘要与被压缩消息交给摘要模型，生成一个新的 checkpoint。后续请求只使用最新 checkpoint 和其后的最近消息。
3. **尾部而非固定轮数**：Hermes 以 token 预算保留最近、最可能仍与当前任务相关的上下文；摘要承担早期决策和事实的保留。
4. **工具消息成对校验**：发送 API 前，Hermes 从 assistant 的 `tool_calls` 收集合法调用 ID，删除找不到父调用的 tool 结果；对没有对应结果的工具调用也进行清理。这样可避免 OpenAI 兼容接口拒绝孤立工具消息。
5. **失败不提交**：压缩摘要失败时，不把半成品写入会话，下一次仍能从原有效历史恢复。

## 与云效 Agent 当前实现的差异

| 维度 | 当前实现 | Hermes 原则 | 本次落地 |
| --- | --- | --- | --- |
| 触发依据 | 固定 128K、buffer、消息数、物理历史 | 完整请求预算 | 用现有 `tokenEstimator` 估算系统提示词、有效历史和 tools |
| 模型能力 | 不随模型变化 | 基于模型上下文 | 每模型手填最大上下文，默认 262144 |
| 摘要 | 1024 token 固定摘要，已有摘要可用 | 增量 checkpoint | 保留 append-only checkpoint，并从有效历史重压缩 |
| 尾部 | 逆向截取，工具边界判断不完整 | 工具链原子保留 | 调用和全部结果作为不可拆分单元 |
| 工具孤儿 | 未统一清理 | 发送前规范化 | 写 checkpoint 前清理并记录数量 |
| 可操作性 | 仅自动 | 自动与手动 | 原生 Settings + `/compact` |

## 本项目的设计约束

- token 仍为现有 `ceil(字符数 / 4)` 估算，不能与提供商计费 token 混为一谈；75% 默认阈值提供估算误差余量。
- 不物理删除 `MessageStore` 历史，避免破坏历史 UI 和故障恢复；最新 `compaction` 消息定义 LLM 的有效起点。
- 模型最大上下文属于模型档案，自动开关与比例属于 VSCode 原生 Settings。二者不混入同一个插件设置页面。
- `/compact` 是宿主动作而不是聊天内容，运行中拒绝，防止在工具调用和工具结果之间形成不合法 checkpoint。

## 验收不变量

- 触发估算必须包含 system prompt、有效历史和实际 tools，且 system prompt 不能重复计数。
- 每个保留 tool 结果都必须找到 parent assistant tool call；每个保留 assistant tool call 都必须有完整结果。
- 摘要失败不能新增 checkpoint 或丢失有效历史。
- 手动命令不进入 MessageStore。
- 日志能用 sessionId 关联一次压缩的判定、清理和结果。
