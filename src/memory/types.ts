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
}

/** 助手消息 */
export interface AssistantMessage {
	readonly role: 'assistant';
	readonly content: string;
	readonly toolCalls?: ToolCall[];
	readonly seq: number;
	/** 本步 token 账快照（真实 usage + 四类拆分 + 来源） */
	readonly tokenUsage?: TokenUsageSnapshot;
}

/** 工具结果消息 */
export interface ToolMessage {
	readonly role: 'tool';
	readonly toolCallId: string;
	readonly content: string;
	readonly seq: number;
}

/** 上下文压缩检查点消息 */
export interface CompactionMessage {
	readonly role: 'compaction';
	/** 压缩摘要文本 */
	readonly summary: string;
	/** 压缩时保留的近期消息原文（含 seq） */
	readonly recentContext: Message[];
	readonly seq: number;
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
