## 1. ToolCallTracker — 重复调用检测器

- [x] 1.1 创建 `src/agent/toolCallTracker.ts`：实现 `ToolCallTracker` 类，提供 `check(tool, args): number` 方法返回连续重复次数，key 为 `tool + JSON.stringify(args)`（sorted keys）
- [x] 1.2 编写单元测试 `src/test/agent/toolCallTracker.test.ts`：验证连续相同调用计数递增、不同调用重置、阈值触发后清零

## 2. ToolResultCache — 只读工具结果缓存

- [x] 2.1 创建 `src/agent/toolResultCache.ts`：实现 `ToolResultCache` 类，提供 `get(tool, args)`、`set(tool, args, result)`、`has(tool, args)` 方法，key 为 `tool + JSON.stringify(args)`（sorted keys）
- [x] 2.2 编写单元测试 `src/test/agent/toolResultCache.test.ts`：验证缓存命中返回结果、write 工具不缓存、新 run 缓存为空

## 3. AgentLoop 集成 — 收敛控制

- [x] 3.1 在 `AgentLoopConfig` 中增加 `repeatThreshold`（默认 3）和 `cacheReadTools`（默认 true）字段
- [x] 3.2 在 `AgentLoop.run()` 开头初始化 `ToolCallTracker` 和 `ToolResultCache` 实例
- [x] 3.3 在工具执行循环中（`for (const tc of pendingToolCalls)`），执行前检查缓存（read 工具 + cacheReadTools=true），命中则返回 `[cached]` 前缀结果
- [x] 3.4 执行前检查 `ToolCallTracker`，达到 `repeatThreshold` 时注入引导消息并跳过执行
- [x] 3.5 工具执行成功后，对 read 工具将结果存入 `ToolResultCache`
- [x] 3.6 在 step 达到 `maxSteps * 0.8` 时追加预警 user 消息（不 break、不禁用工具）
- [x] 3.7 工具执行完毕后增加 `compactIfNeeded` 检查（除每轮开始时的检查外）
- [x] 3.8 编写集成测试 `src/test/agent/agentLoop.convergence.test.ts`：验证重复检测触发引导消息、缓存命中跳过执行、步数预警注入

## 4. compaction 增强 — 摘要模板 + 触发策略

- [x] 4.1 在 `CompactionConfig` 中增加 `messageThreshold`（默认 40）字段
- [x] 4.2 修改 `compactIfNeeded` 函数：增加消息条数检查，任一阈值达到即触发
- [x] 4.3 修改 `FIRST_SUMMARY_PROMPT` 和 `INCREMENTAL_SUMMARY_PROMPT`：增加 "Failed Attempts" 和 "Completed Work" 结构化字段
- [x] 4.4 修改 `messagesToText` 函数：对 tool 消息区分 success/error 状态，输出到对应字段
- [x] 4.5 编写单元测试 `src/test/agent/compaction.test.ts`：验证双阈值触发、摘要模板含新字段

## 5. 系统提示词 + 配置

- [x] 5.1 在 `DEFAULT_AGENT_PROMPT` 中增加 "Loop prevention" 段落（不重复调用、失败换方法、完成后停止）
- [x] 5.2 在 `extension.ts` 中将 `agent.maxSteps` 默认值从 50 改为 25
- [x] 5.3 在 `extension.ts` 中增加 `agent.repeatThreshold`（默认 3）和 `agent.cacheReadTools`（默认 true）配置读取
- [x] 5.4 在 `extension.ts` 中增加 `compaction.messageThreshold`（默认 40）配置读取

## 6. 验证

- [x] 6.1 运行全部现有测试，确保无回归
- [x] 6.2 运行新测试，确保全部通过
- [ ] 6.3 手动测试：执行一个简单任务（如"读取某个文件并总结"），验证在 5-10 步内完成
- [ ] 6.4 手动测试：观察 LLM 卡住时的行为，验证重复检测和引导消息正常工作
