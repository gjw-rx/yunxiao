## Why

当前 Agent Loop 缺少上下文压缩机制，长对话会导致 token 超限（context overflow）或 LLM 丢失早期上下文。需要实现增量式锚定摘要压缩，确保长对话场景下 Agent 能自动压缩历史并保持上下文连贯，参考 opencode 的 compaction 策略。

## What Changes

- **新增** `src/agent/tokenEstimator.ts`：token 估算器，基于字符数/4 近似估算
- **新增** `src/agent/compaction.ts`：上下文压缩模块，包含分割算法、摘要生成、触发逻辑
- **修改** `src/agent/agentLoop.ts`：在每轮开始前调用压缩检查，在 overflow 时自动恢复
- **新增** `src/agent/compaction.test.ts`：压缩模块的单元测试和集成测试

## Capabilities

### New Capabilities
- `context-compaction`: 上下文压缩能力，包括 token 估算、消息分割、摘要生成、自动触发和 overflow 恢复

### Modified Capabilities
<!-- No existing capability requirements are changing. Compaction is a new internal mechanism. -->

## Impact

- 新增文件：`src/agent/tokenEstimator.ts`, `src/agent/compaction.ts`
- 修改文件：`src/agent/agentLoop.ts`（集成压缩检查点）
- 新增测试文件：`src/agent/compaction.test.ts`
- 所有新增代码在 `src/agent/` 目录下，不影响现有模块