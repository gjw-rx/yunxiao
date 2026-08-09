## 1. 参数校验基础设施

- [x] 1.1 新增轻量 JSON Schema 校验器(`src/core/schemaValidator.ts`):支持 `type`/`required`/`properties`/`items`/`enum`/`minimum`/`maximum`/`minLength`/`maxLength`/`additionalProperties` 子集;对未知关键字保守放行并记日志;导出 `compileValidator(parameters) -> (args) => string[]`(返回错误列表)
- [x] 1.2 新增错误类型 `InvalidArgumentsError`(扩展 `ToolValidationError`,`src/core/errors.ts`),文案含字段明细与 `Please rewrite the input so it satisfies the expected schema.` 指导语
- [x] 1.3 `ToolRegistry` 注册时编译校验器并缓存(`toolRegistry.ts`),暴露 `validateArgs(toolName, args)`;子类手写 `validate` 保留,顺序为 schema 校验 → 手写校验
- [x] 1.4 `ToolRouter.route` 集成统一校验(替换 `tool.validate` 直调),校验失败返回 `status:'error'` + `metadata.retryable:false`,不抛未捕获异常

## 2. 工具执行失败统一兜底

- [x] 2.1 `ToolRouter.route` 用统一 try/catch 包住「校验 → 审计 → 执行」,异常转 `ToolResult{status:'error', error: <仅 message 不含堆栈>, metadata:{retryable}}`;堆栈仅入 `logger.error`,不弹窗
- [x] 2.2 移除 `toolRouter.ts` 中 execute 失败后 `throw` 上抛路径(保留 journal 记录语义),`agentLoop.executeSingleTool` 的 catch 降级为最后防线
- [x] 2.3 中断/拒绝语义确认:`abortSignal`/审批拒绝返回 `status:'cancelled'`,不自动重放(journal `execution_state:'unknown'` 分支不变)

## 3. fs.read_file 分页读取重构

- [x] 3.1 schema 增加 `offset`(1 起始,默认 1)与 `limit`(默认 2000)参数;`description` 更新:行号输出、大文件用 offset 续读、单行上限提示
- [x] 3.2 改为流式逐行读取(`fs.createReadStream` + 手动 `TextDecoder({stream:true})`),按「行数 limit + 累计字节(默认 50KB,`Buffer.byteLength`)」双预算提前停止,`maxFileSize`(1MB)作为护栏
- [x] 3.3 输出带行号 `i+offset: <line>`;单行超 2000 字符截断标注;结尾按状态输出 `End of file` / `Showing lines a-b of N. Use offset=<next> to continue` / `Output capped at X KB` 三种标注
- [x] 3.4 `offset` 越界返回 `status:'error'`(含文件总行数与实际 offset);二进制检测、敏感文件脱敏、`pathGuard` 解析保持现状

## 4. fs.list_dir 分页

- [x] 4.1 schema 增加 `offset`(默认 1)与 `limit`(默认 2000);目录条目超过 limit 时返回首页 + `Use offset=<next> to continue`(含剩余条数)
- [x] 4.2 分页与现有 `.gitignore` 过滤、递归 opt-in、条目元数据(名称/类型/大小/mtime)兼容

## 5. 结果治理双限升级

- [x] 5.1 `BaseTool.governResult` 从字符 head+tail 裁剪升级为「`maxLines`(默认 2000)+ `maxBytes`(默认 50KB)」双限,超限截断并附"可用 offset 分页读取"续读指引;二进制跳过、密钥脱敏不变
- [x] 5.2 治理参数经 `ToolContext` 注入(`toolResultLimit` 语义保留为字符兜底),默认值保证现有行为兼容

## 6. 配置与描述文案

- [x] 6.1 `package.json` `contributes.configuration` 新增 `yunxiaoAgent.readFile.{maxLines,maxBytes,maxLineLength}` 与 `yunxiaoAgent.toolResult.{maxLines,maxBytes}`(均含默认值与中文说明);`maxFileSize` 复用顶层 `yunxiaoAgent.maxFileSize` 作为护栏
- [x] 6.2 `AgentLoopConfig`/`ToolContext` 透传新配置;`modelConfig.ts` 读取路径确认(如适用)

## 7. 测试与验证

- [x] 7.1 `schemaValidator` 单测:必填缺失/类型错误/枚举/数字边界/未知关键字放行
- [x] 7.2 `toolRouter` 单测:校验失败结构化返回、execute 异常兜底(无堆栈)、retryable 标记、cancelled 语义
- [x] 7.3 `readFile` 单测:小文件整体、分页续读、字节预算截断、单行截断、offset 越界、大文件返回首页(非 error)、二进制/敏感脱敏回归
- [x] 7.4 `listDir` 单测:分页与超限提示、gitignore 回归
- [x] 7.5 `governResult` 单测:行数超限/字节超限/续读指引/脱敏回归
- [x] 7.6 全量 `npm run compile`(check-types + lint + esbuild)与 `npm test` 通过
