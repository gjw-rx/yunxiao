## Context

云效 Agent 已将会话消息写入每 workspace 一个目录下的 JSONL 文件，并以 `index.json` 保存标题、消息数、Todo 与 Plan 状态。该实现的运行时契约仍是线性 `Message[]`：消息仅有 `seq`，`MessageStore` 在删除、截断、token 回写和 1000 条上限时重写或丢弃文件内容；`SessionFileStore` 把异步写入错误记录到日志后继续运行。`HistoryLoader` 和 compaction 直接从这条线性列表构建上下文。

Pi 的价值不在其 UI 命令，而在其会话模型：带版本 header 的追加式 Entry 日志、`id + parentId` 描述的逻辑路径，以及从当前 leaf 投影出的模型上下文。本 change 将该模型适配到现有 VS Code 插件，不复制 Pi 的运行时或消息协议。

约束：保持本地 JSONL 和无外部数据库依赖；保持现有 `MessageStore`、AgentLoop、聊天面板的迁移路径；保留用户明确删除数据时的物理清理能力；不在本 change 提供树形 UI、fork、导入导出或实时事件回放。

## Goals / Non-Goals

**Goals:**

- 把会话归档定义为版本化、可验证、以追加记录为主的持久化契约。
- 为每条可恢复记录提供稳定 ID、父引用、物理记录顺序和时间戳，并持久化当前活动位置。
- 将完整归档、活动路径、LLM 上下文和会话索引分离为不同投影。
- 让 AgentLoop 能等待用户消息、最终 assistant 消息和工具结果完成归档后再推进对应生命周期。
- 将 compaction 改为摘要加保留 Entry 边界，不再复制近期消息或通过容量上限删掉原始归档。
- 让旧裸消息 JSONL 可安全迁移，并让缺失或损坏的索引可由归档重建。

**Non-Goals:**

- 不实现聊天树、从节点重试、fork/clone、分支摘要、导入导出或 HTML 查看器。
- 不实现 EventBus 事件持久化、断线 replay 或新的远程 Run 协议。
- 不引入 SQLite、多进程 writer lease 或跨设备同步。
- 不把 Todo、Plan、Rollback、ChangeJournal 改为分支感知状态；它们继续使用现有存储语义，后续树功能变更再处理。
- 不保证磁盘掉电级别的 `fsync` 耐久性；本 change 的“提交成功”表示应用已获得文件系统写入成功结果。

## Decisions

### 1. 使用内部 SessionRecord v2，而非直接兼容 Pi JSONL

新会话文件的首条记录为 `SessionHeader`，包含 `type: "session"`、`version`、`sessionId`、创建时间和 workspace 信息。后续记录使用统一的物理 `recordSeq` 和时间戳；会话树节点另有 `id`、`parentId` 与业务 payload。至少包含 `message`、`compaction` 和 `head_update` 三类记录。

`message` payload 沿用当前 Message 的角色、工具调用和 token 信息，但 Entry 身份不再依赖 `seq`。现有 `seq` 作为 UI 与 rollback 兼容投影保留，并映射到稳定的物理记录顺序。

不直接复用 Pi 格式，因为双方的 Message、工具结果、Todo/Plan 与本地工具安全状态契约不同。以后若需要互操作，新增显式 Pi importer/exporter，而不是把内部格式锁死为外部格式。

备选方案是在现有 Message 上直接增加 `id`、`parentId` 字段。该方案无法清晰表达 header、head 更新和非消息 checkpoint，且会让旧的重写 API 继续成为事实模型，故不采用。

### 2. 原始归档、活动路径和 LLM 上下文采用三层投影

`SessionArchiveRepository` 读取完整 `SessionRecord[]` 并维护 ID 索引。它提供：

- 完整归档：供恢复、审计和后续导出使用；
- 活动路径：从已持久化 head 沿 `parentId` 回溯得到；
- LLM 上下文：活动路径经最新 compaction 处理后的消息投影。

`MessageStore` 先作为兼容门面，向当前 AgentLoop 和聊天面板返回活动路径消息；完整归档与 Entry 查询由新 repository 暴露。`index.json` 只缓存列表所需的元数据和活动位置，不能作为会话是否存在的唯一来源。

备选方案是继续让 `MessageStore` 直接持有完整可变数组。该方案无法区分审计历史与模型上下文，也无法安全容纳未来分支。

### 3. 正常写入追加；破坏性操作显式重写

正常用户、assistant、tool、compaction 和 head 更新记录只追加。归档不再使用 `MAX_MESSAGES` 删除旧消息；UI 和上下文由投影层各自限制大小。

现有“永久删除消息”和物理会话删除仍是破坏性操作，允许通过临时文件加原子替换重写归档，并必须同步既有 rollback/change 资产清理。现有 `rollbackTurn` 则改为恢复文件、持久化活动 head 到目标 turn 之前、从活动投影中排除后续消息，同时保留原始 Entry 供审计；它不等同于永久删除。

备选方案是以 tombstone 替代全部删除。它不能满足当前删除语义中的物理清理和隐私预期，因此不作为本 change 的默认删除实现。

### 4. 引入可等待的会话提交边界

存储层必须为一次或多次排队写入提供可拒绝的 `commit`/`flush` Promise，不能吞掉写入错误后仍返回成功。AgentLoop 在模型调用前等待用户消息提交；在发布终态前等待本次最终 assistant 和工具结果提交。扩展停用时等待全部待提交会话写入完成。

实时 `EventBus` 继续即时分发流式内容，不作为会话归档的成功凭据。提交失败必须令对应运行进入可见失败状态并保留可定位日志。

备选方案是仅在 `deactivate()` 处调用现有 `flush()`。这无法防止运行中已经向 UI 宣告完成而归档失败，故不采用。

### 5. compaction 使用保留边界而不是消息副本

`CompactionEntry` 保存摘要、`firstKeptEntryId` 和现有可选 `todoContext`。构建上下文时，系统在活动路径上使用最新有效 checkpoint：摘要代表较早历史，边界及其后的有效路径消息作为原文尾部。

尾部选择仍以完整工具调用/结果单元为边界。若引用缺失、父链循环或工具配对不完整，归档加载必须标记为损坏并拒绝将不合法序列交给 LLM；不得静默构造不完整上下文。

备选方案是继续存 `recentContext` 副本。该方案会重复数据，且原始历史一旦截断就无法验证或重建 checkpoint，故不采用。

### 6. 旧格式按会话原子迁移，索引按需重建

旧 JSONL 的每条 Message 按原物理顺序转换为线性 `message` Entry，并分配稳定 ID、`parentId` 与 header。迁移在临时文件完成校验后，以原子替换提交；原文件保留可恢复备份，失败时继续按旧只读格式打开且不得覆盖原件。

缺失或损坏的 `index.json` 由合法 session header 扫描重建。非法 JSONL 行、重复 ID、悬挂 parent、循环和不合法 compaction 边界必须产生诊断；恢复策略只允许使用已验证的连续记录，且不得自动重写未知损坏原件。

## Risks / Trade-offs

- [存储契约变更波及 MessageStore、AgentLoop、压缩和测试] → 先以兼容门面保留既有读取 API，并为旧/新格式双读建立独立测试。
- [异步提交改为可等待可能增加每 turn 延迟] → 仅在用户消息准入和最终记录边界等待；流式增量仍直接发送给 UI。
- [永久删除与追加归档目标冲突] → 明确区分回滚和永久删除；仅后者采用受确认的重写路径。
- [历史文件被手工修改或截断] → 校验 header、ID、父链、compaction 边界和工具关系；保留诊断与原件，不静默迁移。
- [Todo/Plan 仍为会话级 sidecar，在未来分支下可能与历史路径不一致] → 本 change 不暴露树导航；后续树功能 change 必须把状态投影纳入设计。
- [Windows 文件替换与扩展关闭竞态] → 写入串行化、临时文件和 rename；deactivate 等待所有 pending commit。

## Migration Plan

1. 增加 v2 record 类型、repository 和投影测试，但保持旧 JSONL 可读。
2. 将 MessageStore 接到 repository，先在新建或首次写入时生成 v2 header；保持旧调用方可读取活动消息。
3. 为既有会话实施按会话惰性迁移：先写临时文件、校验、备份原文件，再原子替换；失败时只读旧文件并输出日志。
4. 切换 AgentLoop 到提交确认边界，并在 extension deactivate 等待落盘。
5. 切换 compaction 到边界引用投影，移除归档层的 1000 条截断。
6. 发布后保留旧格式读取与备份恢复窗口；若发现迁移问题，可回退到旧 reader 并从备份恢复，不回写 v2 文件。

## Open Questions

- 旧 JSONL 的备份保留多久，以及是否提供用户可见的恢复入口？默认建议保留到下一次成功激活后再由单独保留策略处理。
- “提交成功”是否需要额外 `fsync` 配置以覆盖掉电场景？默认不引入，避免改变普通插件 I/O 性能。
- 未来导出格式是否需要与 Pi JSONL 互操作？本 change 只保证内部 v2 的稳定性。
