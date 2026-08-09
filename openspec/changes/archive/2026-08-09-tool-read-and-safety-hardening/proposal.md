## Why

当前 `fs.read_file` 对超过 1MB 的文件直接报错拒绝、1MB 以内的文件被整体读入后按 10KB 字符头尾裁剪,模型拿到的既无行号、也无法分页续读——大文件场景(长日志、生成代码、数据文件)要么完全不可读,要么读到被截断且无法定位的内容。与此同时,工具调用环节的参数校验依赖各工具手写 `validate`,失败信息没有指导模型"重写参数"的结构化文案;`toolRouter` 中 `validate` 抛错直接上抛、`execute` 失败与成功走两条错误返回路径,缺少统一的"失败即结构化结果"兜底。

参考 opencode 的 read/truncate 与工具防护设计(分页读取 + 字节硬上限、Schema 运行时校验、失败转结构化错误回传模型),将这两块能力补强到本插件。

## What Changes

**大文件读取(`fs.read_file` 升级)**
- 新增 `offset`(1 起始行号)与 `limit`(行数)参数,输出按 `行号: 内容` 带行号返回。
- 读取采用「行数上限 + 字节硬上限」双预算:超过任一上限即停止并返回截断提示(`Use offset=<next> to continue`),模型可续读,**不再整体拒绝大文件**。
- 单行超过上限(如 2000 字符)截断并标注;UTF-8 按字节计数。
- `fs.list_dir` 目录列表支持分页(offset/limit),超限提示续读。
- 二进制检测与敏感文件脱敏保持现状;图片/PDF 本期不做 attachment(网关多模态能力未定),继续按二进制拒绝。

**工具安全防护**
- 参数校验:注册工具时用其 `parameters`(JSON Schema)编译运行时解码器,路由层对所有工具做统一校验,替代/补强手写 `validate`;校验失败返回 `status: "error"` + `InvalidArgumentsError` 文案("参数不符合 schema,请重写输入"),不抛未捕获异常。
- 失败兜底:路由层统一捕获 `validate` 与 `execute` 的异常,转成结构化 `ToolResult{status:"error", error: <仅 message,不含堆栈>}`,保证模型总能拿到失败 JSON 重新规划。
- 结果治理升级:`BaseTool.governResult` 从字符级裁剪升级为「行数 + 字节」双限(可配置),截断提示附续读指引;二进制/脱敏逻辑保持。
- 防循环:现有 doom loop 检测(连续同工具同参数)保留,失败返回保持 `metadata.retryable` 语义,供模型决策是否重试。

**不做**(本期范围外):短期记忆/会话消息优化、DB 持久化、缓存前缀标记、工具输出落盘。

## Capabilities

### New Capabilities
- `large-file-read`:大文件/大目录的分页读取能力——行号输出、offset/limit 分页、行数+字节双预算、单行截断、超限续读提示。
- `tool-argument-validation`:工具参数的运行时 JSON Schema 校验与结构化失败反馈,含统一错误文案与兜底工具处理。
- `tool-execution-failure-handling`:工具执行失败的统一兜底——异常转结构化错误结果、无堆栈泄漏、不打断 Agent 循环。

### Modified Capabilities
- `file-tools`:修改 `Requirement: fs.read_file tool`——从"超过最大文件大小则拒绝"改为"在字节预算内分页读取、超限提示续读";`Requirement: fs.list_dir tool` 增加分页场景。
- `security-boundary`:修改 `Requirement: Unified tool result governance`——治理从字符级裁剪升级为行数+字节双限,截断提示含续读指引;补充参数校验失败的结构化返回场景。

## Impact

- **代码**:`src/tools/fs/readFile.ts`(分页/行号/字节预算重构)、`src/tools/fs/listDir.ts`(分页)、`src/tools/baseTool.ts`(governResult 双限)、`src/core/toolRouter.ts`(统一校验入口 + 失败兜底)、`src/core/errors.ts`(InvalidArgumentsError 文案)、`src/core/toolRegistry.ts`(注册时编译解码器)、`src/tool/` 新增兜底工具(如 `tool.invalid`)、`extension.ts`(注册)。
- **配置**:`package.json` `contributes.configuration` 新增 `yunxiaoAgent.*` 项(读文件字节预算、默认行数、单行上限、结果治理行/字节上限)。
- **协议**:工具结果格式不变(`ToolResult{status,error,metadata}`);无 SSE 事件协议变更。
- **测试**:更新 `src/test/tools/fs/readFile.test.ts`、`listDir.test.ts`、`toolRouter.test.ts`,新增分页/双预算/参数校验/失败兜底用例。
- **依赖**:无新增运行时依赖。
