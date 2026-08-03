## Why

Phase 3 引入的 `CodeIndexer`（全量 trigram 倒排索引）在插件激活时对**整个工作区**建索引，且只排除 `node_modules`、不遵循 `.gitignore`。实测本开发仓库会被索引进 `.vscode-test`（909MB 的整套 VS Code 安装）、`out/`、`dist/`、`coverage/` 等，产生约 2800 万条索引条目、常驻扩展宿主内存 1.7GB+，导致扩展宿主被系统 OOM 杀掉或卡死——进程被直接 SIGKILL，任何错误日志都捕获不到，表现为读取文件/分析代码/调试终端"莫名报错、无报错信息"。业界主流（Claude Code / Codex / OpenCode）均**不预建索引**，而是用按需执行的 ripgrep（Agentic Search）：零常驻内存、无索引过期、`.gitignore` 自动生效。本项目应回归该路线。

## What Changes

- **BREAKING**：删除 `code.search_index` 本地工具（云端若已装配该工具，须随 `local_tools` 上报移除同步下架）。
- 删除代码索引实现 `src/tools/index/`（`codeIndexer.ts`、`indexStore.ts`、`searchIndex.ts`）及对应单测。
- 删除 `yunxiaoAgent.indexEnabled` 配置项与 `better-sqlite3` 可选依赖（从未被启用，原生模块与 Electron ABI 存在隐患），移除 `esbuild.js` 中 `better-sqlite3` external。
- `src/extension.ts` 移除索引器初始化、注册 `code.search_index`、后台 `buildAll()` 调用及索引器事件监听。
- 探索式/模糊查询回归 `fs.search_files`（Phase 2 已封装 ripgrep，`.gitignore` 自动生效、结果上限 100 条）+ `code.find_references`（符号级定位）；`fs.search_files` 的 schema 描述补充承担该职责（行为不变）。
- 移除 e2e/单测中 `search_index`、`CodeIndexer`、`IndexStore` 相关用例。
- 保留 `code.get_diagnostics` / `code.workspace_symbols` / `code.find_references` / `code.go_to_definition` 四个代码智能工具（不涉及本次变更）。

## Capabilities

### New Capabilities
<!-- 无新增能力 -->

### Modified Capabilities
- `code-index`: 该能力整体移除——删除 `code.search_index` 工具、`CodeIndexer`、`IndexStore` 及其全部行为要求（预建索引、增量更新、暂停/恢复、后台构建、sqlite 持久化、只读声明）。探索式检索改由现有 `file-tools` 能力的 `fs.search_files`（ripgrep，`.gitignore` 感知）与 `code-intelligence` 能力的 `code.find_references` 承担。

## Impact

- **删除代码**：`src/tools/index/{codeIndexer,indexStore,searchIndex}.ts`、`src/test/tools/index/`。
- **改动代码**：`src/extension.ts`（移除索引器装配）、`src/tools/fs/searchFiles.ts`（仅 schema 描述补充）、`src/test/integration/e2e.test.ts`（移除 search_index 用例）。
- **依赖**：`package.json` 移除 `better-sqlite3` optionalDependencies；`esbuild.js` 移除 `better-sqlite3` external；`package-lock.json` 同步。
- **配置**：`package.json` contributes.configuration 移除 `yunxiaoAgent.indexEnabled`。
- **文档联动**：`docs/04-架构演进规划.md` 及 Phase 3 相关文档中 `code.search_index` / 索引器的定位标注为"已移除"；云端 Agent 仓库同步移除 `code.search_index` 工具装配与系统提示指导。
- **非目标**：不引入新的语义/向量检索能力；不改动 `code.*` 四个代码智能工具；不动终端/Git（Phase 4）。
