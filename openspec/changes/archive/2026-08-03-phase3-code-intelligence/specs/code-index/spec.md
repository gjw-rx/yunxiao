## ADDED Requirements

### Requirement: CodeIndexer with trigram indexing
The system SHALL implement a `CodeIndexer` that builds a trigram inverted index over workspace code files. It SHALL tokenize files into 3-character grams and maintain a `trigram -> Set<{file, line}>` mapping. It SHALL support a `search(query: string, topK?: number)` method that ranks files by trigram Jaccard similarity to the query and returns the top K results with snippets and scores. The indexer SHALL index only code files (by extension whitelist: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.java`, `.go`, `.rs`, `.c`, `.cpp`, `.h`, `.css`, `.html`, `.json`, `.md`) and SHALL skip files exceeding the configured max file size.

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
The `CodeIndexer` SHALL listen to `vscode.workspace.onDidSaveTextDocument` to re-index individual files on save, `vscode.workspace.onDidCreateFiles` to add new files to the index, and `vscode.workspace.onDidDeleteFiles` to remove deleted files from the index. This SHALL keep the index consistent with the filesystem without full rebuilds.

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
The `CodeIndexer` SHALL support `pause()` and `resume()` methods. When paused, the indexer SHALL NOT process file change events. The indexer SHALL expose an `isIndexing` property indicating whether the initial full index build is in progress. The indexer SHALL be controllable via the `yunxiaoAgent.indexEnabled` configuration setting; when disabled, the indexer SHALL NOT start and `code.search_index` SHALL return an error.

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
The `CodeIndexer` SHALL perform the initial full index build asynchronously in the background after extension activation. It SHALL NOT block the extension activation or the UI. Until the initial build completes, `code.search_index` SHALL return `{ status: 'error', error: '索引构建中，请稍后重试' }`. The indexer SHALL expose a `ready: boolean` property to check if the initial build is complete.

#### Scenario: Search during initial build
- **WHEN** the extension just activated and the initial index build is in progress and `code.search_index` is called
- **THEN** the tool returns `status: 'error'` with message '索引构建中，请稍后重试'

#### Scenario: Search after build completes
- **WHEN** the initial index build has completed and `code.search_index` is called
- **THEN** the tool returns `status: 'success'` with search results

### Requirement: IndexStore interface with memory and optional sqlite
The system SHALL define an `IndexStore` interface with `save(entries: Map<string, Set<FileRef>>): void`, `load(): Map<string, Set<FileRef>>`, `query(trigrams: string[]): Map<FileRef, number>`, and `clear(): void` methods. The default implementation SHALL be `MemoryIndexStore` using in-memory `Map`. An optional `SqliteIndexStore` SHALL be used when `better-sqlite3` is available, persisting the index to `context.globalStorageUri/path/index.db`. When `better-sqlite3` is not available, the system SHALL silently fall back to `MemoryIndexStore` without error.

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
The system SHALL implement `code.search_index` (permission `read`, site `local`) that exposes the `CodeIndexer.search()` capability as a local tool. It SHALL accept `{ query: string, topK?: number }` parameters (topK default 10, max 50). It SHALL return a JSON string containing `{ results: [{ file, line, snippet, score }] }`. When the index is not ready (building or disabled), it SHALL return `status: 'error'` with a descriptive message.

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
`code.search_index` SHALL declare permission `read` and site `local`. It SHALL NOT mutate the filesystem. It SHALL execute without user approval.

#### Scenario: No approval required for search_index
- **WHEN** the agent calls `code.search_index`
- **THEN** the tool executes immediately without an approval prompt
