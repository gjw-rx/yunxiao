## Context

插件当前使用 `SessionManager` 按 `sessionId` 保存一次用户输入及其多轮 SSE 续流状态。新输入会复用并清空同一个 `SessionState`，但旧连接、旧工具 Promise 和旧续流回调仍然持有对该状态的引用，因此可能在新输入开始后追加内容、执行工具或将新运行标记结束。事件总线又只暴露通用的 `stream_end`，导致 UI 无法可靠区分正常完成、用户取消、失败和连接中断。

`POST /api/agent/invoke/tool_result` 通常返回 SSE，但重复提交会返回 `application/json` 的 `{ duplicate: true }` acknowledgement。现有 tool-result 客户端只按 SSE 成功响应处理，不能表达“结果已被接纳，但本连接没有后续事件”。

`code.edit` 会先读取文件、生成 diff、展示预览并等待审批，随后直接将预览文件 rename 到目标。审批等待期间目标文件可能被用户或格式化器修改，初次 `expectedVersion` 校验无法覆盖这一时间窗口。

## Goals / Non-Goals

**Goals:**

- 恢复只覆盖插件源码和测试的可靠 TypeScript 编译门禁。
- 隔离同一 Session 下先后发起的本地运行，使任何异步回调只能修改创建它的运行。
- 为本地运行提供明确且互斥的终态。
- 正确处理 tool-result duplicate JSON acknowledgement，不重复执行或误报正常完成。
- 阻止 `code.edit` 应用审批期间已经过期的 diff。
- 用回归测试锁定以上行为。

**Non-Goals:**

- 不引入云端持久 `AgentRun`、事件序列、执行 lease 或 SSE replay。
- 不在插件中持久化 RunStore 或 execution journal。
- 不改变 v1 云端 endpoint、请求体和正常 SSE 事件格式。
- 不实现文件系统级 compare-and-swap、工作区快照或通用撤销。
- 不重构 Webview UI 或拆分 `chatPanel.ts`。

## Decisions

### 1. TypeScript 工程显式包含 `src/**/*.ts`

`tsconfig.json` 使用显式 `include` 限定插件源码和位于 `src/test` 的测试，并排除 `dist`、`out`、`coverage`、`docs` 及其他 vendored/generated 内容。现有 `rootDir: "src"` 保持不变。

选择显式 include 而不是逐项修复 vendored OpenCode 类型，是因为后者不属于插件构建产物，也不应受插件 TypeScript 版本和 VSCode 类型环境约束。

### 2. 使用管理器级单调 generation 隔离运行

`SessionManager` 维护管理器生命周期内单调递增的 generation counter。每次 `sendMessage` 创建新的 generation 并写入当前 `SessionState`；SSE callbacks、工具执行、timeout、continuation 和错误处理都捕获该 generation。

所有异步入口在读取或修改状态前检查：

1. `sessions.get(sessionId)` 仍是预期的状态对象；
2. 当前状态的 generation 与回调捕获值相等；
3. 运行尚未进入终态。

检查失败时回调静默退出，不追加事件、不执行工具、不回传结果。使用管理器级单调值而不是删除状态后从 1 重新计数，可以避免 reset 后 Session ID 复用产生 ABA 问题。

### 3. 运行状态与流连接状态分开表达

增加面向本地运行的状态：

```text
idle -> running -> completed
                -> cancelled
                -> failed
                -> disconnected
```

终态只能设置一次。正常 reader EOF 且本轮不存在待执行工具时为 `completed`；显式用户取消为 `cancelled`；服务端错误信封、HTTP/协议错误或本地 orchestration 异常为 `failed`；网络连接意外丢失，以及收到 duplicate acknowledgement 但无法取得原续流时为 `disconnected`。

事件总线增加结构化运行状态事件作为 UI 的事实来源。为保持现有 Webview 兼容，可以继续发送旧 `stream_end` 通知，但新状态不得由 `stream_end` 反推，且旧 generation 不得发送任何终态事件。

### 4. tool-result 响应先按 Content-Type 分派

tool-result 客户端在读取 body 前检查响应 Content-Type：

- `text/event-stream`：使用现有 `SseStreamParser`。
- `application/json` 且 `success=true`、`data.duplicate=true`：触发独立 duplicate acknowledgement 回调。
- 其他成功 JSON：视为协议错误，避免静默吞掉不认识的控制响应。

duplicate acknowledgement 表示相同结果已经被云端接纳，因此客户端不得重试上传、不得重新执行工具，也不得调用正常 SSE `onEnd`。在当前尚无 replay API 的阶段，SessionManager 将运行标记为 `disconnected`，保留“云端状态未知”的事实，而不是猜测运行已经完成。

### 5. `code.edit` 使用预览基线版本进行审批后复核

工具读取目标内容后立即计算预览基线版本。若调用方提供 `expectedVersion`，先验证它与该基线一致。diff 和预览文件都基于同一份内容生成。

用户允许后、rename 前重新获取目标版本并与预览基线比较：

- 相同：继续应用预览文件。
- 不同或文件消失：删除预览文件，返回不可重试 conflict，保留当前目标。
- 用户拒绝：维持现有 cancelled 行为。

该设计解决审批等待窗口，不声称提供跨“最后一次校验到 rename”微小窗口的文件系统 compare-and-swap。更强的工作区事务属于后续 snapshot/patch change。

### 6. 以行为回归测试作为实施顺序

先新增能够复现缺陷的测试，再修改实现。测试使用可控 callback、deferred Promise 和临时文件，不依赖真实云端服务；VSCode Webview E2E 留到运行时间线 change。

## Risks / Trade-offs

- [继续发送旧 `stream_end` 可能让旧 UI 保留模糊显示] → 同时发送结构化运行状态，新增测试确保新逻辑只消费明确终态；UI 重构在后续 change 完成。
- [duplicate acknowledgement 后插件无法知道云端最终输出] → 明确标记 `disconnected`，不猜测完成；未来由 v2 replay/subscription 恢复。
- [generation guard 分散在多个异步路径容易漏检] → 收口为单一 `isCurrentRun`/`withCurrentRun` 检查，并覆盖 SSE、工具、timeout、续流和 catch 路径。
- [审批后版本校验仍非文件系统 CAS] → 将校验放在写入前的最后一个 await 之后；完整事务和 revert 另行设计。
- [收紧 tsconfig 可能暴露此前被跳过的插件类型错误] → 将修复限制在 `src`，不修改 vendored 源码。

## Migration Plan

1. 先提交编译范围和回归测试，使 `check-types` 能稳定检查插件代码。
2. 增加 generation 与结构化终态，同时保留旧 `stream_end` 兼容事件。
3. 增加 duplicate acknowledgement 分派并接入 SessionManager。
4. 增加 `code.edit` 审批后版本复核。
5. 运行类型检查、lint、单元测试和现有 VSCode 测试门禁。

回滚时可恢复旧 SessionManager/SSE 适配实现和 tsconfig；本 change 不包含数据库迁移或云端 API 破坏性变更。

## Open Questions

- 后续 v2 replay change 是否保留 `disconnected` 作为本地连接状态，还是将其从 Run 终态中拆为独立 transport 状态；本 change 先按当前无恢复能力的现实表达为本地终态。
