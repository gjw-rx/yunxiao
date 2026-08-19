/**
 * 记忆管理类型定义 - 本地消息存储的核心类型契约。
 * 与 src/llm/types.ts 的 LLMMessage 分离：存储层带 seq 序号和 attachments。
 */

// ── 辅助类型 ──

/** 附件（用户消息可携带文件附件） */
export interface Attachment {
	readonly path: string;
	readonly content: string;
	readonly mimeType: string;
}

/** 工具调用（LLM 返回的 function call） */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	/** JSON 格式的参数字符串 */
	readonly arguments: string;
}

/**
 * token 数字来源标记：真实 usage 或估算。
 */
export type TokenSource = 'usage' | 'estimated';

/**
 * 每步 token 账快照（挂到 assistant 消息）。
 * 四类之和与总量自洽：总量 = prompt+completion（权威），上下文 = prompt − 用户输入。
 */
export interface TokenUsageSnapshot {
	/** 本次 LLM 调用的真实 usage（provider 报告） */
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
	/** 思考 token（usage 提供时） */
	readonly reasoning_tokens?: number;
	/** 缓存命中读取 token（provider 提供 cache 明细时存在，来源为 usage） */
	readonly cache_read_tokens?: number;
	/** 缓存写入 token（provider 提供 cache 明细时存在，来源为 usage） */
	readonly cache_write_tokens?: number;
	/** 非缓存输入 token（provider 提供 cache 明细时存在，来源为 usage） */
	readonly no_cache_tokens?: number;
	/** 思考（优先 usage，缺失时估算） */
	readonly reasoning: number;
	/** 工具调用（对 toolCall.name+arguments 估算） */
	readonly tool_calls: number;
	/** 模型回复（completion − reasoning − 工具调用，clamp ≥ 0） */
	readonly model_output: number;
	/** 用户输入（分摊法） */
	readonly user_input: number;
	/** 上下文 = prompt_tokens − user_input，非四类之一 */
	readonly context: number;
	/** 拆分数字是否包含估算（估算比例来源标记） */
	readonly source: TokenSource;
	/** 实际调用 Provider 标识（如 "openai"）；旧归档缺失时用于归入"未知模型" */
	readonly provider_id?: string;
	/** 实际调用模型标识（如 "gpt-4o-mini"）；旧归档缺失时用于归入"未知模型" */
	readonly model_id?: string;
	/** 调用当时的非敏感模型展示名（仅用于历史显示，不含鉴权信息） */
	readonly model_label?: string;
}

/** 助手最终回复关联的会话代码变更概览。 */
export interface ChangeSetReference {
	/** 变更集 ID。 */
	readonly id: string;
	/** 受影响文件数量。 */
	readonly fileCount: number;
	/** 累计新增行数。 */
	readonly additions: number;
	/** 累计删除行数。 */
	readonly deletions: number;
}

// ── 消息类型 ──

/** 系统消息 */
export interface SystemMessage {
	readonly role: 'system';
	readonly content: string;
	readonly seq: number;
}

/** 用户消息 */
export interface UserMessage {
	readonly role: 'user';
	readonly content: string;
	readonly seq: number;
	readonly attachments?: Attachment[];
	/** 用户输入 token 分摊值（估算，供会话累计） */
	readonly inputTokens?: number;
	/** 是否为系统注入消息（step 预警、空回复提示、doom 引导等）；真实用户输入缺省为 false，用于识别 turn 边界 */
	readonly injected?: boolean;
}

/** 助手消息 */
export interface AssistantMessage {
	readonly role: 'assistant';
	readonly content: string;
	readonly toolCalls?: ToolCall[];
	readonly seq: number;
	/** 本步 token 账快照（真实 usage + 四类拆分 + 来源） */
	readonly tokenUsage?: TokenUsageSnapshot;
	/** 最终回复对应的会话代码变更概览。 */
	readonly changeSet?: ChangeSetReference;
}

/** 工具结果消息 */
export interface ToolMessage {
	readonly role: 'tool';
	readonly toolCallId: string;
	readonly content: string;
	/** 工具结果是否复用了当前运行中此前已加载的数据。 */
	readonly reused?: boolean;
	readonly seq: number;
}

/** 上下文压缩检查点消息 */
export interface CompactionMessage {
	readonly role: 'compaction';
	/** 压缩摘要文本 */
	readonly summary: string;
	/** 保留原文边界的消息 seq：该 seq 及之后的活动路径消息作为尾部原文，不再复制近期消息副本 */
	readonly firstKeptSeq: number;
	/** 保留边界对应的归档 Entry ID（文件模式存在；内存模式缺失，由 firstKeptSeq 兜底） */
	readonly firstKeptEntryId?: string;
	/** 压缩检查点时捕获的活跃任务上下文（可选；旧检查点或当时无活跃任务时缺失）。 */
	readonly todoContext?: string;
	readonly seq: number;
	/** 兼容旧检查点（v1）：复制近期消息的旧字段，仅旧检查点存在。 */
	readonly recentContext?: Message[];
}

/** 存储层消息（discriminated union） */
export type Message =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolMessage
	| CompactionMessage;

/** 追加消息时的输入类型（不含 seq，由 MessageStore 分配） */
export type InputMessage =
	| Omit<SystemMessage, 'seq'>
	| Omit<UserMessage, 'seq'>
	| Omit<AssistantMessage, 'seq'>
	| Omit<ToolMessage, 'seq'>
	| Omit<CompactionMessage, 'seq'>;

// ── 版本化会话归档记录（v2） ──
// 会话以追加式 JSONL 持久化：首条有效记录为 SessionHeader，后续为 ArchiveEntry。
// 正常消息、压缩检查点与活动位置更新只追加；破坏性删除走显式重写路径。

/** 会话归档版本号（v2 = 版本化追加式归档）。 */
export const SESSION_ARCHIVE_VERSION = 2;

/** 归档 Entry 的业务类型。 */
export type EntryKind = 'message' | 'compaction' | 'head_update';

/**
 * 会话归档首条记录的 session header。
 * 包含会话 ID、版本、创建时间与 workspace 信息；header 之前的记录均视为非法。
 */
export interface SessionHeader {
	readonly type: 'session';
	/** 归档版本号，必须为 SESSION_ARCHIVE_VERSION。 */
	readonly version: number;
	/** 会话 ID（UUID）。 */
	readonly sessionId: string;
	/** 创建时间（ISO 字符串）。 */
	readonly createdAt: string;
	/** 所属 workspace 根路径（可选；迁移或降级读取时缺失）。 */
	readonly workspacePath?: string;
}

/**
 * 归档 Entry（可恢复节点）：统一携带 id、parentId、物理 recordSeq 与时间戳。
 * parentId 为 null 表示该 Entry 是会话首条记录（根）。
 */
export interface ArchiveEntry {
	readonly type: 'entry';
	/** 业务类型：消息 / 压缩检查点 / 活动位置更新。 */
	readonly kind: EntryKind;
	/** 稳定记录 ID（UUID），归档内唯一。 */
	readonly id: string;
	/** 父记录 ID（逻辑父链）；首条记录为 null。 */
	readonly parentId: string | null;
	/** 物理记录序号（从 1 开始单调递增，header 不占序号）。 */
	readonly recordSeq: number;
	/** 记录时间戳（ISO 字符串）。 */
	readonly timestamp: string;
	/** Entry payload（按 kind 区分）。 */
	readonly payload: EntryPayload;
}

/** 归档 Entry payload 联合。 */
export type EntryPayload =
	| MessageEntryPayload
	| CompactionEntryPayload
	| HeadUpdateEntryPayload;

/** message Entry payload：携带现有 Message 兼容投影（含 seq）。 */
export interface MessageEntryPayload {
	readonly kind: 'message';
	/** 存储层消息（保留 seq 兼容投影，映射到稳定物理记录顺序）。 */
	readonly message: Message;
}

/** compaction Entry payload：摘要 + 保留原文边界，不再复制近期消息副本。 */
export interface CompactionEntryPayload {
	readonly kind: 'compaction';
	/** 增量压缩摘要文本。 */
	readonly summary: string;
	/** 保留原文的边界：该 ID 及之后的活动路径消息作为尾部原文。 */
	readonly firstKeptEntryId: string;
	/** 压缩检查点时捕获的活跃任务上下文（可选）。 */
	readonly todoContext?: string;
}

/** head_update Entry payload：持久化活动位置。 */
export interface HeadUpdateEntryPayload {
	readonly kind: 'head_update';
	/** 当前活动 Entry ID（活动路径叶节点）；null 表示空活动路径（回滚到会话开头）。 */
	readonly headEntryId: string | null;
}

/** 版本化会话记录（v2 JSONL 每行）：header 或普通 Entry。 */
export type SessionRecord = SessionHeader | ArchiveEntry;
