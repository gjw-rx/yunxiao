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
}

/** 助手消息 */
export interface AssistantMessage {
	readonly role: 'assistant';
	readonly content: string;
	readonly toolCalls?: ToolCall[];
	readonly seq: number;
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
