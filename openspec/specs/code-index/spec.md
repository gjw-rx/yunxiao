## REMOVED Requirements

### Requirement: CodeIndexer with trigram indexing
**Reason**: 全量 trigram 倒排索引在扩展宿主激活时构建并常驻内存。实测本开发仓库会因 `findFiles` 不遵循 .gitignore 而索引 `.vscode-test`（909MB VS Code 安装）、`out/`、`dist/` 等，产生约 2834 万条索引条目（约 1.7GB+ 内存），导致扩展宿主被 OOM 杀掉且无错误日志。业界主流（Claude Code/Codex/OpenCode）均不预建索引，改用按需 ripgrep（Agentic Search）。探索式查询改由 `fs.search_files`（ripgrep，.gitignore 感知）与 `code.find_references` 承担。
**Migration**: 使用 `fs.search_files`（regex/glob + 上下文行）做内容探索，`code.workspace_symbols` 按符号名定位，`code.find_references` 做引用定位。`code.search_index` 已从 `local_tools` 上报中移除，云端须同步下架该工具。

#### Scenario: Build index and search
- **WHEN** the indexer builds an index over a workspace with `src/utils.ts` containing `function getLogger()` and `search('getLogger', 5)` is called
- **THEN** the search returns `src/utils.ts` with a high similarity score and a snippet containing the match

#### Scenario: Search with no index
- **WHEN** `search` is called before the index has been built
- **THEN** the search returns an empty result set (or an error indicating the index is not ready)

#### Scenario: Non-code files excluded
- **WHEN** the workspace contains a `.png` file and the indexer builds an index
- **THEN** the `.png` file is not included in the index

### Requirement: Incremental index updates
**Reason**: 增量更新实现按对象引用去重（`Set.add` 每次新建 FileRef 对象），同一文件每次保存都重复插入整份索引条目，导致索引无限膨胀；删除文件时全量重建造成卡顿。该机制随 CodeIndexer 一并移除。
**Migration**: 无需替代——搜索改按需执行 ripgrep，天然反映磁盘实时内容，不存在索引与文件系统不一致问题。

#### Scenario: File save triggers re-index
- **WHEN** a code file is saved and the indexer is active
- **THEN** the file's trigrams are updated in the index

#### Scenario: File deletion removes index entries
- **WHEN** a code file is deleted and the indexer is active
- **THEN** all trigram entries pointing to that file are removed from the index

#### Scenario: File creation adds index entries
- **WHEN** a new code file is created and the indexer is active
- **THEN** the file's trigrams are added to the index

### Requirement: Index pause and resume
**Reason**: 暂停/恢复、`isIndexing`/`ready` 状态与 `yunxiaoAgent.indexEnabled` 配置均服务于预建索引生命周期。索引移除后不再需要该生命周期管理与配置项。
**Migration**: 删除 `yunxiaoAgent.indexEnabled` 配置；无索引状态管理需求。

#### Scenario: Pause stops processing events
- **WHEN** the indexer is paused and a file is saved
- **THEN** the index is not updated for that file

#### Scenario: Resume resumes processing events
- **WHEN** the indexer is resumed after being paused
- **THEN** subsequent file save events are processed and the index is updated

#### Scenario: Index disabled via config
- **WHEN** `yunxiaoAgent.indexEnabled` is `false` and `code.search_index` is called
- **THEN** the tool returns `status: 'error'` indicating indexing is disabled

### Requirement: Background async initial index build
**Reason**: 激活时后台全量索引 `buildAll()` 读取全工作区文件（仅排除 node_modules），产生 GB 级常驻内存并拖垮扩展宿主。该异步构建机制随 CodeIndexer 移除。
**Migration**: 不再有初始索引构建；搜索按需执行，插件激活即时可用。

#### Scenario: Search during initial build
- **WHEN** the extension just activated and the initial index build is in progress and `code.search_index` is called
- **THEN** the tool returns `status: 'error'` with message '索引构建中，请稍后重试'

#### Scenario: Search after build completes
- **WHEN** the initial index build has completed and `code.search_index` is called
- **THEN** the tool returns `status: 'success'` with search results

### Requirement: IndexStore interface with memory and optional sqlite
**Reason**: `MemoryIndexStore` 将 2800 万条索引条目常驻扩展宿主堆内存导致 OOM；`SqliteIndexStore` 依赖 `better-sqlite3` 原生模块（与 Electron ABI 不兼容风险）且从未启用。索引存储层随 CodeIndexer 一并移除。
**Migration**: 删除 `src/tools/index/indexStore.ts` 与 `better-sqlite3` 可选依赖及 esbuild external；无持久化索引需求。

#### Scenario: Memory store saves and loads
- **WHEN** entries are saved to a `MemoryIndexStore` and `load()` is called
- **THEN** the loaded entries match the saved entries

#### Scenario: Sqlite fallback to memory
- **WHEN** `better-sqlite3` is not installed and the indexer is initialized
- **THEN** the system uses `MemoryIndexStore` without error

#### Scenario: Sqlite persistence across restarts
- **WHEN** `better-sqlite3` is available, the index is saved to sqlite, the extension is deactivated and reactivated
- **THEN** the index is loaded from sqlite and available without a full rebuild

### Requirement: code.search_index tool
**Reason**: 该工具依赖预建索引，索引移除后无实现载体；且与 `fs.search_files`（ripgrep）功能重叠。按 Claude Code 路线整体删除。
**Migration**: 探索式/模糊查询改用 `fs.search_files`（regex/glob + 上下文）与 `code.find_references`（引用定位）。`local_tools` 上报不再包含 `code.search_index`，云端 Agent 系统提示须移除对该工具的引导。

#### Scenario: Search index for a code pattern
- **WHEN** `code.search_index` is called with `{ query: 'authentication middleware' }` and the index is ready
- **THEN** the tool returns `status: 'success'` with ranked results containing file, line, snippet, and similarity score

#### Scenario: Search index with custom topK
- **WHEN** `code.search_index` is called with `{ query: 'error handler', topK: 20 }`
- **THEN** the tool returns up to 20 results

#### Scenario: topK capped at maximum
- **WHEN** `code.search_index` is called with `{ query: 'test', topK: 100 }`
- **THEN** the tool caps topK to 50 and returns at most 50 results

#### Scenario: Search index not ready
- **WHEN** `code.search_index` is called and the index is still building
- **THEN** the tool returns `status: 'error'` with message '索引构建中，请稍后重试'

#### Scenario: No results found
- **WHEN** `code.search_index` is called with `{ query: 'zzznonexistent' }` and no matching trigrams exist
- **THEN** the tool returns `status: 'success'` with an empty results array

### Requirement: All code index tools are read-only
**Reason**: `code.search_index` 只读声明随工具删除失效；保留的 `code.*` 智能工具（get_diagnostics/workspace_symbols/find_references/go_to_definition）仍为只读，相关要求在 `code-intelligence` 能力中继续有效。
**Migration**: 无需替代；`code-intelligence` 能力的只读要求不受影响。

#### Scenario: No approval required for search_index
- **WHEN** the agent calls `code.search_index`
- **THEN** the tool executes immediately without an approval prompt