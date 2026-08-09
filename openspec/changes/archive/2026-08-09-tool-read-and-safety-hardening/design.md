# Design: 工具调用大文件处理与安全防护

## Context

当前插件(`yunxiao-agent`)的工具调用链路为:云端 SSE 下发 `tool_call`(args 已结构化为对象)→ `ToolRouter.route`(`src/core/toolRouter.ts`)→ 安全审计 → 审批门 → `tool.validate` + `tool.execute` → `governResult` 治理 → 回传模型。

现状问题:

1. **大文件不可读**:`fs.read_file`(`src/tools/fs/readFile.ts`)对超过 1MB(`maxFileSize`)的文件直接返回 error;1MB 以内文件整体读入后,经 `BaseTool.governResult`(`src/tools/baseTool.ts`)裁剪为 10KB 字符(头 2000 + 尾)。无行号、无 `offset/limit` 分页、无单行截断,长文件/长行文件要么拒读、要么读到无法定位的碎片。
2. **参数校验分散且失败信息无指导**:校验靠各工具手写 `validate`(默认空实现);`toolRouter.ts:26` 直接调用 `tool.validate(call.args)`,抛错未在路由层捕获;错误文案无"请重写输入以满足 schema"的结构化指导。
3. **失败兜底有两条路径**:`execute` 失败在 `toolRouter.ts:91-102` catch 后记录 journal 并 **`throw`** 上抛,由 `agentLoop.executeSingleTool` 再 catch 转 `ToolResult`;`validate` 抛错则完全未捕获。错误信息含完整 `error.message`(自定义错误可能带堆栈),堆栈会经 `logger.notifyError` 弹窗,且不同路径错误形态不一致。

参考实现:opencode(`docs/opencode源码/opencode/packages/opencode/src/tool/read.ts`、`truncate.ts`、`tool.ts`、`session/processor.ts`)。

**约束**:本项目无 DB(短期记忆为内存 `MessageStore` + workspaceState),无 zod/ajv 依赖,工具 schema 为简单 JSON Schema;网关(OpenAI 兼容)多模态能力未定,本期不支持图片/PDF attachment。

## Goals / Non-Goals

**Goals:**
- `fs.read_file` 支持分页读取:行号输出、`offset/limit`、行数+字节双预算、单行截断、超限续读提示;大文件不再整体拒绝。
- `fs.list_dir` 支持分页。
- 工具参数统一运行时校验(基于注册时的 JSON Schema),失败返回结构化错误 + 重写指导文案,不抛未捕获异常。
- 路由层统一兜底 `validate` 与 `execute` 异常,转为 `ToolResult{status:'error'}`(仅 message、无堆栈),Agent 循环不中断,模型可重新规划。
- `governResult` 治理升级:行数 + 字节双限、可配置、截断提示附续读指引。

**Non-Goals:**
- 短期记忆 / 会话消息优化、DB 持久化、缓存前缀标记(opencode 的 prefix-cache 设计不在本期)。
- 图片/PDF 以 attachment 返回(网关多模态未定,继续按二进制拒绝)。
- 工具输出落盘(`tool-output/` 目录)与 7 天保留。
- `invalid` 兜底工具(见 Decisions 7)。
- 工具级自动重试/熔断(除现有 doom loop 检测外;重试决策交给模型)。

## Decisions

### 1. 读取预算:行数 + 字节双上限,统一流式分页
`fs.read_file` 全部走**流式逐行读取**(`fs.createReadStream` + 手动 `TextDecoder.decode(..., {stream:true})`,避免解码器吞掉未终止行),按预算累积:行数 `limit`(默认 2000)与累计字节(UTF-8 `Buffer.byteLength`,默认 50KB)任一超限即停止,返回已读行 + 截断标注 + `Use offset=<next> to continue`。小文件即一页读完。单行超过 2000 字符截断并标注。
- **备选 A**:先 `readFile` 全文再 `slice`——大文件内存浪费,且无法实现"预算内即停"。拒绝。
- **备选 B**:仅行数限制——防不住长行文件(minified JS/日志)。拒绝。
- `maxFileSize`(默认 1MB)保留,语义从"拒绝阈值"变为"字节预算的护栏":实际读取预算 = `min(maxBytes, maxFileSize)`;超过护栏时按预算返回首页而非 error(兼容旧配置)。

### 2. 输出格式:带行号 + 续读提示
输出按 `i + offset: <line>` 带行号;结尾标注三种状态之一:全部读完(`End of file - total N lines`)、行预算截断(`Showing lines a-b of N. Use offset=<next> to continue`)、字节预算截断(`Output capped at X KB ...`)。参考 `read.ts:338-351`。`<path>/<type>/<content>` 包装保持与现有协议一致(纯文本结果)。

### 3. 参数校验:注册时编译轻量 JSON Schema 解码器(自研,零依赖)
在 `ToolRegistry` 注册工具时,用其 `parameters`(JSON Schema 子集:`type`/`required`/`properties`/`items`/`enum`/`minimum`/`maximum`/`minLength`/`maxLength`/`additionalProperties`)编译一次校验函数并缓存;`ToolRouter.route` 在校验钩子处统一执行。校验失败 → 结构化错误,文案含具体字段与 `Please rewrite the input so it satisfies the expected schema.` 指导。
- **备选 A**:引入 `ajv`——成熟但新增运行时依赖,与本项目"零新增依赖"不符。拒绝(若未来 schema 复杂度超出自研子集,再评估)。
- **备选 B**:维持手写 `validate`——覆盖不全、重复代码。拒绝。
- 子类手写 `validate` 保留:在 schema 校验之后运行,二者任一失败均返回结构化错误(双保险)。

### 4. 失败兜底:路由层统一捕获,单一路径返回
`ToolRouter.route` 内用统一 `try/catch` 包住「参数校验 → 审计 → 执行」,任何异常转 `ToolResult{status:'error', error: <仅 message>, metadata:{retryable}}`;不再向 `agentLoop` 上抛(`agentLoop.executeSingleTool` 的 catch 保留为最后防线)。错误信息剥离堆栈:`error` 字段只取 `message`;堆栈仅入日志(`logger.error`),不弹窗、不进模型上下文。
- `metadata.retryable`:参数校验失败 `false`(应重写参数);业务失败由工具显式标注 `retryable: true` 时允许模型调整后重试;中断/拒绝 `status:'cancelled'`。

### 5. 结果治理升级:行数 + 字节双限
`BaseTool.governResult` 从"字符 head+tail 裁剪"升级为:先按 `maxLines`(默认 2000)与 `maxBytes`(默认 50KB,受 `toolResultLimit` 兜底)判超;超限时保留头尾摘要(head 2000 字符 + tail)+ 截断标记,并附"若需完整内容可用 `offset` 分页读取"的续读指引。二进制跳过、密钥脱敏逻辑保持不动。治理配置经 `ToolContext` 注入。

### 6. 配置项
`package.json` `contributes.configuration` 新增(均有默认值,向后兼容):
- `yunxiaoAgent.readFile.maxLines`(2000)、`maxBytes`(50KB)、`maxLineLength`(2000)、`maxFileSize`(1MB,护栏)
- `yunxiaoAgent.toolResult.maxLines`(2000)、`maxBytes`(50KB)
通过现有 `AgentLoopConfig`/`ToolContext` 传递,不在工具内直接读配置。

### 7. 不引入 `invalid` 兜底工具
opencode 用 `experimental_repairToolCall` 把"未知工具/参数解析失败"重定向到 `invalid` 工具。本项目工具调用经云端 SSE 协议下发,args 已结构化为对象、参数解析失败场景极少;未知工具已由 `route` 返回结构化 error(含工具名提示)。引入 `invalid` 工具需改注册与协议面,收益低。**决策:统一结构化错误返回即兜底**;若未来直接对接 LLM 流式 tool-call,再评估 `invalid` 工具。

### 8. 防循环保持现状
现有 `DoomLoopDetector`(连续 3 次同工具同参数 → 注入引导消息,`agentLoop.ts`)已覆盖"多次调用同一错误工具"场景,本期不改为审批式熔断;失败结果 `retryable:false` 配合系统提示词引导模型换策略。

## Risks / Trade-offs

- [自研校验器只覆盖 JSON Schema 子集,超集 schema 可能误判] → 校验器对未知关键字保守放行并记日志;文档标注支持子集;后续可平滑换 ajv。
- [字节预算对多字节 UTF-8(中文)按字节计数,行截断体验略粗] → 使用 `Buffer.byteLength` 精确计费,超限行整体截断并标注,行号仍准确。
- [流式读取手动 decode 可能丢未终止行] → 参照 opencode 注释:手动 `TextDecoder` + 流结束 flush,并补测试覆盖无换行符结尾文件。
- [`maxFileSize` 语义从"拒绝"变"护栏",依赖旧行为的模型可能困惑] → 同步更新 `fs.read_file` 的 `description`(引导使用 `offset/limit`),测试断言大文件返回首页而非 error。
- [`governResult` 改动影响所有工具结果] → 默认值保持当前 10KB 字符量级内的行为(双限默认值均高于现状上限),先行为兼容再扩展。

## Migration Plan

1. 纯代码改造,无数据迁移(无 DB)。
2. 顺序:自研 schema 校验器 → `ToolRouter` 统一兜底 → `fs.read_file` 分页重构 → `fs.list_dir` 分页 → `governResult` 双限 → 配置项与描述文案 → 测试补全。
3. 回滚:本次改动全部可独立 revert;配置均有默认值,不引入新依赖。

## Open Questions

- 图片/PDF attachment:待网关多模态能力确认后单独立项(本期按二进制拒绝)。
- `invalid` 兜底工具:仅在直接对接 LLM 流式 tool-call 时评估。
- 校验器是否需要覆盖 `oneOf`/`anyOf`/`pattern`:当前工具 schema 未使用,暂不支持。
