## Context

Phase 3 引入了 `CodeIndexer`（trigram 倒排索引）+ `MemoryIndexStore` + `code.search_index` 工具，目标是为大工作区提供模糊/语义检索。实测该实现在扩展宿主进程内存在严重问题：

- 激活时 `buildAll()` 用 `vscode.workspace.findFiles('**/*', '**/node_modules/**')` 枚举全工作区，**只排除 node_modules、不遵循 .gitignore**，会把 `.vscode-test`（909MB 的整套 VS Code 测试安装）、`out/`、`dist/`、`coverage/` 全部纳入索引。
- 本仓库实测：825 个代码文件、约 2 亿字符，生成约 **2834 万条 `FileRef` 常驻内存（~1.7GB+）**。
- 增量更新按对象引用去重（`Set.add` 每次新建对象），每次保存文件都重复膨胀索引；删除文件时 `load()` 全量重建，大索引下卡顿数秒。
- 扩展宿主被 OOM 杀掉（SIGKILL）时无任何日志，`uncaughtException`/`unhandledRejection` 钩子捕获不到 → 表现为"读取文件/分析代码/调试终端莫名报错、无报错信息"。

业界调研结论（Claude Code / Codex CLI / OpenCode）：主流终端型 Agent 均**不预建代码索引**，采用按需 ripgrep 的 Agentic Search——零常驻内存、无索引过期、`.gitignore` 自动生效、结果即时反映磁盘状态；Claude Code 创建者 Boris Cherny 明确说明早期 RAG+向量库方案因"性能、安全、隐私、过期、可靠性"问题被弃用。唯一重度建索引的 Cursor 也将索引放在云端向量库（Turbopuffer）+ Merkle 增量，编辑器进程内不保留全量索引。

本项目 Phase 2 已具备 `fs.search_files`（ripgrep 封装，`--json` 输出、结果上限 100、Node 回退），Phase 3 的 `code.find_references`/`code.workspace_symbols` 提供符号级定位。故回归 Agentic Search 路线，移除预建索引。

## Goals / Non-Goals

**Goals**
- 消除扩展宿主内的常驻大索引：激活不再触发全量索引，进程内零索引内存。
- 删除 `code.search_index` 工具及 `CodeIndexer`/`IndexStore`/`searchIndex` 全部实现与配置。
- 确保探索式/模糊查询有等价替代路径：`fs.search_files`（ripgrep 精确/正则 + 上下文）+ `code.find_references`（符号级引用）。
- 清理相关依赖与配置：`better-sqlite3` optionalDependencies、`yunxiaoAgent.indexEnabled`、esbuild external。
- 单测/e2e 同步移除相关用例，`npm run check-types`/`lint`/`compile`/`test` 全绿。

**Non-Goals**
- 不引入任何新的语义/向量检索能力（向量检索若未来需要，按独立进程/MCP 方式补，不进入扩展宿主）。
- 不改动 `code.get_diagnostics` / `code.workspace_symbols` / `code.find_references` / `code.go_to_definition` 四个保留工具。
- 不做终端/Git（Phase 4）与 UI 重构（Phase 5）。
- 不在本仓库内修改云端 Agent 代码（仅文档联动提示）。

## Decisions

### D1：直接删除 `code.search_index`，而非改为即时 ripgrep 别名
- **选择**：删除。备选方案"保留工具名、实现改为按需 rg"实质是 `fs.search_files` 的别名，功能重复、schema 冗余、云端还需维护一个多余工具。
- **理由**：与 Claude Code/Codex/OpenCode 的做法一致——模糊查询本身就是 Agent 用 grep 多轮探索的过程，单一"语义检索工具"收益有限且带来维护成本。

### D2：搜索替代路径 = `fs.search_files`（ripgrep）+ `code.find_references`
- `fs.search_files`（Phase 2 已实现）：regex/glob 两种模式，`rg --json -C 2`，MAX_MATCHES=100 截断，rg 缺失时 Node 回退（限 500 文件）。**ripgrep 默认遵循 .gitignore**，天然规避构建产物/测试安装目录，且按需执行零常驻内存。
- `code.find_references`：对已知符号做引用定位，替代原 search_index 的"按名检索"场景；`code.workspace_symbols` 可先按符号名缩小范围。
- 不做任何实现改动，仅更新 `fs.search_files` 的 schema description，向 LLM 说明其承担探索式检索职责。

### D3：彻底删除 `CodeIndexer`/`IndexStore`/`searchIndex` 代码与配置
- **选择**：物理删除 `src/tools/index/`、相关单测、`indexEnabled` 配置、`better-sqlite3` 依赖与 esbuild external。
- **理由**：保留即债务。该实现存在结构性问题（索引粒度为行级 FileRef、去重依赖对象引用），未来若需索引应重写而非修补；用户已确认不留"默认禁用"的保留模式。
- **备选被否**：保留代码 + `indexEnabled` 默认 false——维护面大、且 1.7GB 隐患在误开启时复发。

### D4：`code-index` 规格以 REMOVED 形式归档
- 在 delta spec 中逐条 REMOVED 原 `code-index` 能力的全部 requirements（含 Reason/Migration），保证归档后 `openspec/specs/code-index/spec.md` 不存在遗留的"影子要求"。

## Risks / Trade-offs

- **[能力损失] 失去 trigram 模糊/相似度检索（如"找处理鉴权的代码"式查询）** → 缓解：Agentic Search 模式下行/列级 grep + read 多轮探索可覆盖；Claude Code 实测 agentic search 显著优于预建索引；`fs.search_files` 的 regex + 上下文（-C 2）已够定位。
- **[云端回归] 云端 Agent 仍会调用 `code.search_index`（工具已下架）** → 缓解：`local_tools` 上报不再包含该工具，云端按 tools 清单驱动；在 `docs/整体架构计划/Phase3改动计划.md` 标注移除，云端同步更新系统提示与工具装配。
- **[单次搜索耗时] 大工作区 grep 全量扫描** → 缓解：ripgrep SIMD/多线程，Claude Code 实测 4500 文件仓库单次 <0.1s；`fs.search_files` 已有结果上限与路径参数收窄。
- **[误删风险] 删除涉及 extension.ts/e2e/package.json 多处** → 缓解：按 tasks.md 顺序执行，每步 `npm run check-types`/`compile` 验证；git 历史可回滚。

## Migration Plan

1. 本地代码删除与清理（见 tasks.md），每步编译验证。
2. `local_tools` 上报自动不含 `code.search_index`，无需协议改动。
3. 文档联动：更新 `docs/04-架构演进规划.md` 与 Phase 3 文档（`code.search_index`/索引器标注"已移除"）；通知云端移除该工具。
4. 回滚：`git revert` 本 change 即可恢复索引代码（历史 commit 保留）。

## Open Questions

- 云端 Agent 是否已在系统提示中引导 LLM 使用 `code.search_index`？（需云端仓库同步删除，本仓库仅文档提示）
- 未来是否需要真正的语义检索？若需要，建议按"独立 daemon/MCP 进程 + 磁盘向量库"模式引入（如 scrybe/LanceDB 路线），不进入扩展宿主进程。
