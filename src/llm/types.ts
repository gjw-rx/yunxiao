/**
 * LLM 类型定义 - 模型连接层的核心类型契约。
 * 定义消息格式、请求/响应结构、流式事件和 Provider 接口。
 */

// ── 消息类型 ──

/** 系统消息 */
export interface SystemMessage {
	readonly role: 'system';
	readonly content: string;
}

/** 用户消息 */
export interface UserMessage {
	readonly role: 'user';
	readonly content: string;
}

/** LLM 返回的工具调用 */
export interface LLMToolCall {
	readonly id: string;
	readonly name: string;
	/** JSON 格式的参数字符串 */
	readonly arguments: string;
}

/** 助手消息 */
export interface AssistantMessage {
	readonly role: 'assistant';
	readonly content: string;
	readonly toolCalls?: LLMToolCall[];
}

/** 工具结果消息 */
export interface ToolMessage {
	readonly role: 'tool';
	readonly toolCallId: string;
	readonly content: string;
}

/** LLM 消息（discriminated union） */
export type LLMMessage =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolMessage;

// ── 工具定义 ──

/** 供 LLM 使用的工具定义，兼容 OpenAI function calling 格式 */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	/** JSON Schema 描述工具参数 */
	readonly parameters: Record<string, unknown>;
}

// ── 请求类型 ──

/** 工具选择策略 */
export type ToolChoice = 'auto' | 'none' | 'required';

/**
 * 思维链强度（OpenAI reasoning 规范）。
 * - OpenAI: minimal | low | medium | high
 * - DeepSeek: low | medium | high（配合 thinking.type='enabled'）
 * - disabled: 显式关闭思维链（DeepSeek 发送 thinking.type='disabled'）
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'disabled';

/** LLM 请求 */
export interface LLMRequest {
	readonly model: string;
	readonly messages: LLMMessage[];
	readonly tools?: ToolDefinition[];
	readonly toolChoice?: ToolChoice;
	readonly temperature?: number;
	readonly maxTokens?: number;
	/** 思维链强度（缺省由 Provider 决定：DeepSeek 默认开启思考） */
	readonly reasoningEffort?: ReasoningEffort;
	/** 强制流式 */
	readonly stream: true;
	/**
	 * 可选的取消信号（AI SDK runtime 会传入 streamText 以真正取消 provider 请求；
	 * legacy runtime 忽略该字段，仅靠消费端停止读取实现取消）。
	 */
	readonly abortSignal?: AbortSignal;
}

// ── 流式事件 ──

/** 文本增量 */
export interface TextDeltaEvent {
	readonly type: 'textDelta';
	readonly text: string;
}

/** 思维链（推理过程）增量文本，与正文字段分离展示 */
export interface ReasoningDeltaEvent {
	readonly type: 'reasoningDelta';
	readonly text: string;
}

/** 工具调用（已合并增量片段） */
export interface ToolCallEvent {
	readonly type: 'toolCall';
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

/** Token 用量 */
export interface UsageEvent {
	readonly type: 'usage';
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** 思考 token 数(provider 提供时),缺失时为 0 */
	readonly reasoningTokens?: number;
	/** 总 token 数(provider 提供时),缺失时为 input+output */
	readonly totalTokens?: number;
	/** 缓存命中读取 token 数（provider 提供 cache 明细时存在） */
	readonly cacheReadTokens?: number;
	/** 缓存写入 token 数（provider 提供 cache 明细时存在） */
	readonly cacheWriteTokens?: number;
}

/** 流结束 */
export interface FinishEvent {
	readonly type: 'finish';
	readonly reason: 'stop' | 'tool_use' | 'length';
}

/** 错误 */
export interface ErrorEvent {
	readonly type: 'error';
	readonly error: string;
}

/** LLM 流式事件（discriminated union） */
export type LLMEvent =
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| ToolCallEvent
	| UsageEvent
	| FinishEvent
	| ErrorEvent;

// ── Provider 接口 ──

/** LLM Provider 接口：流式返回 LLM 事件 */
export interface LLMProvider {
	chatCompletion(request: LLMRequest): AsyncGenerator<LLMEvent>;
}
