/**
 * 上下文压缩模块 - 锚定摘要策略。
 *
 * 核心流程：
 * 1. 估算当前消息 token 数
 * 2. 超出阈值时分割 head（摘要）和 recent（保留原文）
 * 3. 调用 LLM 生成结构化摘要
 * 4. 存储 CompactionMessage 作为检查点
 * 5. 后续历史加载从检查点开始
 */
import type { Message } from '../memory/types';
import type { MessageStore } from '../memory/messageStore';
import type { LLMProvider, LLMMessage } from '../llm/types';
import type { EventBus } from '../core/eventBus';
import { estimateMessages, estimateMessage } from './tokenEstimator';

// ── 类型定义 ──

/** 上下文压缩配置 */
export interface CompactionConfig {
	/** 是否启用自动压缩 */
	readonly enabled: boolean;
	/** 压缩时保留的近期 token 数 */
	readonly keepTokens: number;
	/** 触发压缩的 buffer（超出 contextWindow - maxOutput - buffer 时触发） */
	readonly buffer: number;
	/** 模型上下文窗口大小 */
	readonly contextWindow: number;
	/** 触发压缩的消息条数阈值（默认 40） */
	readonly messageThreshold?: number;
}

// ── 分割算法 ──

/** 分割结果 */
export interface SplitResult {
	/** 旧消息（将被摘要压缩） */
	head: Message[];
	/** 最新消息（保留原文） */
	recent: Message[];
}

/**
 * 按 token 预算将消息列表分割为 head 和 recent。
 * 从最新消息向前累积 token，达到预算时分割。
 * 边界消息不拆分，整体归入 head。
 */
export function selectMessages(messages: Message[], keepTokens: number): SplitResult {
	const total = estimateMessages(messages);
	if (total <= keepTokens) {
		return { head: [], recent: [...messages] };
	}

	const recent: Message[] = [];
	let accumulated = 0;

	// 从最新消息向前遍历
	for (let i = messages.length - 1; i >= 0; i--) {
		const tokens = estimateMessage(messages[i]);
		if (accumulated + tokens > keepTokens && recent.length > 0) {
			// 超出预算且 recent 已有消息，停止
			break;
		}
		recent.unshift(messages[i]);
		accumulated += tokens;
	}

	const head = messages.slice(0, messages.length - recent.length);
	return { head, recent };
}

// ── 摘要生成 ──

const SUMMARY_PROMPT_TEMPLATE = `You are maintaining a conversation summary. Create or update an anchored summary.

## Objective
- [The user's core objective]

## Important Details
- [Constraints, decisions, key facts]

## Work State
### Completed
- [Completed work]
### Active
- [Active work]
### Blocked
- [Blocked work]

## Failed Attempts
- [Tool name + args + error reason, for each failed attempt]

## Completed Work
- [Successfully completed tool calls and their key outcomes]

## Next Move
1. [Next planned actions]

## Relevant Files
- [Key files involved]`;

const INCREMENTAL_SUMMARY_PROMPT = `Update the existing conversation summary with new information.

Existing summary:
{existingSummary}

New messages to incorporate:
{newContent}

Please provide an updated summary following the same structure:

## Objective
- [Updated objective]

## Important Details
- [Updated details]

## Work State
### Completed
- [Completed work]
### Active
- [Active work]
### Blocked
- [Blocked work]

## Failed Attempts
- [Tool name + args + error reason, for each failed attempt]

## Completed Work
- [Successfully completed tool calls and their key outcomes]

## Next Move
1. [Next planned actions]

## Relevant Files
- [Key files involved]`;

const FIRST_SUMMARY_PROMPT = `Summarize the following conversation history in a structured format.

Conversation:
{content}

Please provide a summary following this structure:

## Objective
- [The user's core objective]

## Important Details
- [Constraints, decisions, key facts]

## Work State
### Completed
- [Completed work]
### Active
- [Active work]
### Blocked
- [Blocked work]

## Failed Attempts
- [Tool name + args + error reason, for each failed attempt]

## Completed Work
- [Successfully completed tool calls and their key outcomes]

## Next Move
1. [Next planned actions]

## Relevant Files
- [Key files involved]`;

/**
 * 调用 LLM 生成结构化摘要。
 * @param headMessages 需要摘要的旧消息
 * @param existingSummary 已存在的摘要（增量更新时传入）
 * @param provider LLM Provider
 * @param model 模型名称
 */
export async function generateSummary(
	headMessages: Message[],
	existingSummary: string | null,
	provider: LLMProvider,
	model: string,
): Promise<string> {
	const content = messagesToText(headMessages);

	let prompt: string;
	if (existingSummary) {
		prompt = INCREMENTAL_SUMMARY_PROMPT
			.replace('{existingSummary}', existingSummary)
			.replace('{newContent}', content);
	} else {
		prompt = FIRST_SUMMARY_PROMPT.replace('{content}', content);
	}

	const messages: LLMMessage[] = [
		{ role: 'system', content: 'You are a precise summarizer. Output only the summary.' },
		{ role: 'user', content: prompt },
	];

	const stream = provider.chatCompletion({
		model,
		messages,
		stream: true,
	});

	let summary = '';
	for await (const event of stream) {
		if (event.type === 'textDelta') {
			summary += event.text;
		} else if (event.type === 'error') {
			throw new Error(`Summary generation failed: ${event.error}`);
		}
	}

	return summary || SUMMARY_PROMPT_TEMPLATE;
}

// ── 压缩触发 ──

/**
 * 检查是否需要压缩，需要则执行压缩并存储 CompactionMessage。
 * @returns 是否执行了压缩
 */
export async function compactIfNeeded(
	sessionId: string,
	messages: Message[],
	provider: LLMProvider,
	model: string,
	config: CompactionConfig,
	messageStore: MessageStore,
	eventBus: EventBus,
): Promise<boolean> {
	if (!config.enabled) {
		return false;
	}

	const totalTokens = estimateMessages(messages);
	const messageCount = messages.length;

	// 计算阈值：contextWindow - maxOutput - buffer
	const threshold = config.contextWindow - (model.includes('maxTokens') ? 4096 : 4096) - config.buffer;
	const msgThreshold = config.messageThreshold ?? 40;

	// 双阈值：token 或 消息条数 任一达到即触发
	if (totalTokens <= threshold && messageCount <= msgThreshold) {
		return false;
	}

	// 分割消息
	const { head, recent } = selectMessages(messages, config.keepTokens);
	if (head.length === 0) {
		return false;
	}

	// 获取已有摘要用于增量更新
	const existingCompaction = messageStore.getCompactionPoint(sessionId);
	const existingSummary = existingCompaction?.summary ?? null;

	// 生成摘要
	const summary = await generateSummary(head, existingSummary, provider, model);

	// 存储 CompactionMessage
	messageStore.append(sessionId, {
		role: 'compaction',
		summary,
		recentContext: recent,
	});

	// 发出事件
	eventBus.emit({
		type: 'run_state_change',
		sessionId,
		payload: {
			generation: 0,
			state: 'running',
			meta: { compaction: true, headTokens: estimateMessages(head), recentTokens: estimateMessages(recent) },
		},
	});

	return true;
}

// ── 辅助函数 ──

/** 将消息列表转为纯文本（用于摘要 prompt）。tool 消息区分 success/error 状态。 */
function messagesToText(messages: Message[]): string {
	const lines: string[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case 'system':
				lines.push(`[System]: ${msg.content}`);
				break;
			case 'user':
				lines.push(`[User]: ${msg.content}`);
				break;
			case 'assistant':
				lines.push(`[Assistant]: ${msg.content}`);
				if (msg.toolCalls) {
					for (const tc of msg.toolCalls) {
						lines.push(`[Tool Call: ${tc.name}](${tc.arguments})`);
					}
				}
				break;
			case 'tool':
				if (msg.content.startsWith('Error:') || msg.content.startsWith('Cancelled:')) {
					lines.push(`[Tool Failed: ${msg.toolCallId}]: ${msg.content.slice(0, 500)}`);
				} else {
					lines.push(`[Tool Succeeded: ${msg.toolCallId}]: ${msg.content.slice(0, 500)}`);
				}
				break;
			case 'compaction':
				lines.push(`[Compaction Summary]: ${msg.summary}`);
				break;
		}
	}
	return lines.join('\n');
}