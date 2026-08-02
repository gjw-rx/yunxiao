# Implementation Tasks - 移除预建代码索引，回归 ripgrep 按需搜索

> 依赖顺序：清理索引实现与配置 -> 搜索替代与 e2e 清理 -> 文档联动 -> 验证。
> 对应 proposal：删除 `code.search_index`/`CodeIndexer`/`IndexStore`，探索式查询回归 `fs.search_files` + `code.find_references`。

## 1. 清理索引实现与配置

- [x] 1.1 删除 `src/tools/index/codeIndexer.ts`、`src/tools/index/indexStore.ts`、`src/tools/index/searchIndex.ts` -> verify: 文件已删除，无残留引用
- [x] 1.2 删除 `src/test/tools/index/` 目录（codeIndexer.test.ts、indexStore.test.ts、searchIndex.test.ts） -> verify: 目录已删除
- [x] 1.3 `src/extension.ts` 移除索引器装配：`MemoryIndexStore`/`CodeIndexer`/`SearchIndexTool` 的 import、`indexEnabled` 配置块（含 `getWorkspaceRoots`/`buildAll`/`dispose` 相关代码）、`registry.register(new SearchIndexTool(...))`。保留 `getWorkspaceRoots` 在 sessionManager 配置中的既有使用 -> verify: `npm run check-types` 通过，`grep -r "CodeIndexer|SearchIndexTool|MemoryIndexStore|indexEnabled" src/` 无命中
- [x] 1.4 `package.json` 移除 `yunxiaoAgent.indexEnabled` 配置项与 `optionalDependencies.better-sqlite3` -> verify: 两处字段已删除
- [x] 1.5 `esbuild.js` 的 `external` 移除 `'better-sqlite3'` -> verify: external 仅剩 `['vscode']`
- [x] 1.6 执行 `npm install` 同步 `package-lock.json` -> verify: lock 文件无 better-sqlite3 条目（注：node_modules 被 root 所有导致 npm install 失败，改为手动清理 lock，JSON 校验通过）

## 2. 搜索替代与 e2e 清理

- [x] 2.1 `src/tools/fs/searchFiles.ts` schema `description` 补充承担探索式/模糊检索职责（如"用于代码探索与模糊定位，替代已移除的 code.search_index"），行为不改 -> verify: check-types 通过
- [x] 2.2 `src/test/integration/e2e.test.ts` 移除 Phase 3 中 `search_index`/`CodeIndexer`/`MemoryIndexStore` 相关 import 与用例（保留 `code.*` 四工具用例） -> verify: `grep -r "search_index|CodeIndexer|MemoryIndexStore" src/test/` 无命中

## 3. 文档联动

- [x] 3.1 `docs/04-架构演进规划.md` 与 `docs/整体架构计划/Phase3改动计划.md`（若存在）中将 `code.search_index`/代码索引相关步骤标注"已移除（回归 ripgrep 按需搜索）" -> verify: 文档不再将索引列为现役能力

## 4. 验证

- [x] 4.1 `npm run check-types` + `npm run lint` + `npm run compile` 全绿 -> verify: 三命令退出码 0
- [x] 4.2 `npm test` 全绿（180 passing 基础上移除 search_index 用例后无新增失败） -> verify: 无 failing（唯一失败为既有 AIClient streamMessage 环境问题，与本次改动无关；用例数 180→165 = 删除的 13 单测 + 2 e2e）
- [x] 4.3 验证 `ToolRegistry.localSchemas()` 上报清单不再包含 `code.search_index`，仍含 `code.get_diagnostics`/`code.workspace_symbols`/`code.find_references`/`code.go_to_definition` 与 `fs.search_files` -> verify: 清单 10 项，无 search_index，五项均在
