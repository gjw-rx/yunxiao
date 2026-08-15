## Why

AI SDK 的 usage 会被直接信任并展示，但上游已返回 `reasoningTokens=-59` 这类不可能的值；缓存命中 token 虽已保留，却没有参与会话汇总或界面说明。同时，单条消息将“本次总消耗 / prompt token”标为上下文占比，分母并不是模型上下文窗口，导致几乎总显示约 100%，容易误导用户。

需要建立可校验的 usage 归一化与统一的展示口径，使调用量、缓存命中和估算值都可追溯，且实时与历史恢复的会话汇总一致。

## What Changes

- 校验并规范化 AI SDK usage 的所有数值，拒绝负数、非有限数和互相矛盾的细分值；不可信的可选细分改走现有估算/缺失语义，不污染持久化账本。
- 保留并汇总输入侧的原始细分（非缓存输入、缓存读取、缓存写入），明确它们与 prompt、总 token 的关系，避免把缓存命中重复计入总量。
- 将每次调用展示改为明确的“本次 token 消耗”及输入/输出/缓存细分；不再把 `total / prompt` 伪装成上下文窗口占比。
- 统一实时汇总与历史恢复的聚合来源，消除用户输入在历史恢复时的重复累计，并展示缓存汇总及数据来源。
- 补充覆盖异常 reasoning、缓存明细、总量一致性和实时/历史一致性的回归测试与诊断日志。

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `token-usage-tracking`: 修订 usage 校验、缓存细分记账、会话聚合和 UI 展示的行为契约。

## Impact

- 涉及 `src/llm/aiSdkStreamAdapter.ts`、`src/llm/types.ts`、`src/agent/agentLoop.ts`、`src/memory/types.ts`、`src/core/types.ts` 与 `src/chatPanel.ts`。
- 涉及 AI SDK usage 适配、消息持久化结构、事件载荷和 Webview token 用量文案；不引入价格/成本计算，也不改变模型请求协议。
- 涉及 `src/test/llm/aiSdkStreamAdapter.test.ts`、`src/test/agent/*TokenAccounting.test.ts` 与 `src/test/chatPanel.test.ts` 的回归覆盖。
