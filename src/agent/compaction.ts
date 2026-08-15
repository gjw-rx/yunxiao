/** 上下文压缩：完整请求预算、增量检查点摘要和工具调用链完整性。 */
import type { EventBus } from '../core/eventBus';
import type { LLMMessage, LLMProvider } from '../llm/types';
import type { MessageStore } from '../memory/messageStore';
import type { SessionTodoStore } from '../memory/sessionTodoStore';
import type { AssistantMessage, Message, ToolCall } from '../memory/types';
import { estimateMessage, estimateMessages } from './tokenEstimator';
import * as logger from '../logger';

/** 上下文压缩配置。 */
export interface CompactionConfig {
	/** 是否启用自动压缩。 */
	readonly autoEnabled: boolean;
	/** 自动压缩触发比例，范围为 1 至 99。 */
	readonly triggerPercent: number;
	/** 最近原文保留比例，范围为 1 至 99。 */
	readonly tailPercent: number;
	/** 当前模型最大上下文 token。 */
	readonly maxContextTokens: number;
	/** 当前模型最大输出 token 预留。 */
	readonly maxOutputTokens: number;
}

/** 压缩触发原因。 */
export type CompactionReason = 'automatic' | 'manual' | 'overflow';

/** 压缩执行结果状态。 */
export type CompactionStatus = 'compacted' | 'skipped' | 'failed';

/** 压缩执行结果。 */
export interface CompactionResult {
	/** 执行状态。 */
	readonly status: CompactionStatus;
	/** 实际使用的触发原因。 */
	readonly reason: CompactionReason;
	/** 完整 LLM 请求的估算 token。 */
	readonly requestTokens: number;
	/** 当前自动触发阈值。 */
	readonly thresholdTokens: number;
	/** 摘要失败时的错误信息。 */
	readonly error?: string;
}

/** 压缩切分结果。 */
export interface SplitResult {
	/** 需要进入摘要的较早消息。 */
	readonly head: Message[];
	/** 保留原文的近期消息。 */
	readonly recent: Message[];
}

/** 工具配对清理结果。 */
export interface ToolPairCleanupResult {
	/** 清理后的消息。 */
	readonly messages: Message[];
	/** 被移除的孤立工具结果 ID。 */
	readonly removedToolResultIds: string[];
	/** 被移除的缺失结果工具调用 ID。 */
	readonly removedToolCallIds: string[];
}

/** 压缩请求选项。 */
export interface CompactOptions {
	/** 触发来源。 */
	readonly reason: CompactionReason;
	/** 系统提示词、历史和工具 schema 合计的请求估算 token。 */
	readonly requestTokens: number;
}

const SUMMARY_SYSTEM_PROMPT = '你是精确的会话摘要器。仅输出结构化摘要，保留目标、约束、已完成工作、当前状态、失败原因和下一步。';

/** 摘要请求的输出 token 预算，为推理模型预留正文生成空间。 */
const SUMMARY_MAX_OUTPUT_TOKENS = 2048;

/**
 * 计算自动压缩的完整请求 token 阈值。
 * @param config 压缩配置。
 * @returns 触发阈值。
 */
export function calculateCompactionThreshold(config: CompactionConfig): number {
	const availableInput = Math.max(1, config.maxContextTokens - config.maxOutputTokens);
	return Math.max(1, Math.floor((availableInput * config.triggerPercent) / 100));
}

/**
 * 根据当前阈值计算近期原文的 token 预算。
 * @param config 压缩配置。
 * @param effectiveTokens 当前有效历史的估算 token。
 * @param reason 压缩触发原因。
 * @returns 尾部原文 token 预算。
 */

function calculateTailTokenBudget(
	config: CompactionConfig,
	effectiveTokens: number,
	reason: CompactionReason,
): number {
	if (reason === 'manual') {
		return Math.max(1, Math.floor((effectiveTokens * config.tailPercent) / 100));
	}
	return Math.max(1, Math.floor((calculateCompactionThreshold(config) * config.tailPercent) / 100));
}

/**
 * 从有效上下文中按 token 预算选择近期消息，并把工具调用链作为原子单元。
 * @param messages 有效历史消息。
 * @param keepTokens 尾部 token 预算。
 * @returns 较早摘要消息和近期原文消息。
 */
export function selectMessages(messages: Message[], keepTokens: number): SplitResult {
	if (estimateMessages(messages) <= keepTokens) {
		return { head: [], recent: [...messages] };
	}

	const retained = new Set<number>();
	let retainedTokens = 0;
	let retainedToolGroup = false;
	for (let index = messages.length - 1; index >= 0;) {
		const group = getAtomicMessageGroup(messages, index);
		const additions = group.filter((itemIndex) => !retained.has(itemIndex));
		const groupTokens = additions.reduce((total, itemIndex) => total + estimateMessage(messages[itemIndex]), 0);
		const currentMessage = messages[index];
		const isToolGroup = group.length > 1 || currentMessage.role === 'tool' || (currentMessage.role === 'assistant' && !!currentMessage.toolCalls?.length);

		if (retained.size > 0 && retainedTokens + groupTokens > keepTokens && (!isToolGroup || retainedToolGroup)) {
			break;
		}

		for (const itemIndex of additions) {
			retained.add(itemIndex);
		}
		retainedTokens += groupTokens;
		retainedToolGroup ||= isToolGroup;
		index = Math.min(...group) - 1;
	}

	const recent = messages.filter((_, index) => retained.has(index));
	const head = messages.filter((_, index) => !retained.has(index));
	return { head, recent };
}

/**
 * 返回消息所属的不可拆分工具调用组。
 * @param messages 有效历史消息。
 * @param index 当前消息下标。
 * @returns 原子消息下标集合。
 */
function getAtomicMessageGroup(messages: Message[], index: number): number[] {
	const message = messages[index];
	if (message.role === 'assistant' && message.toolCalls?.length) {
		return collectToolGroup(messages, index, message.toolCalls);
	}
	if (message.role === 'tool') {
		const parentIndex = findToolCallParent(messages, index, message.toolCallId);
		if (parentIndex !== -1) {
			const parent = messages[parentIndex] as AssistantMessage;
			return collectToolGroup(messages, parentIndex, parent.toolCalls ?? []);
		}
	}
	return [index];
}

/**
 * 收集一个 assistant 工具调用及其全部 tool 结果的下标。
 * @param messages 有效历史消息。
 * @param assistantIndex assistant 消息下标。
 * @param toolCalls 工具调用列表。
 * @returns 工具调用链下标集合。
 */
function collectToolGroup(messages: Message[], assistantIndex: number, toolCalls: readonly ToolCall[]): number[] {
	const callIds = new Set(toolCalls.map((call) => call.id));
	const result = [assistantIndex];
	for (let index = assistantIndex + 1; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === 'assistant' && message.toolCalls?.length) {
			break;
		}
		if (message.role === 'tool' && callIds.has(message.toolCallId)) {
			result.push(index);
		}
	}
	return result;
}

/**
 * 查找 tool 结果对应的 assistant 工具调用父消息。
 * @param messages 有效历史消息。
 * @param toolIndex tool 消息下标。
 * @param toolCallId 工具调用 ID。
 * @returns 父消息下标；找不到时返回 -1。
 */
function findToolCallParent(messages: Message[], toolIndex: number, toolCallId: string): number {
	for (let index = toolIndex - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === 'assistant' && message.toolCalls?.some((call) => call.id === toolCallId)) {
			return index;
		}
	}
	return -1;
}

/**
 * 清理孤立 tool 结果与缺少结果的 assistant 工具调用。
 * @param messages 需要校验的消息。
 * @returns 清理后的消息及移除记录。
 */
export function sanitizeToolPairs(messages: Message[]): ToolPairCleanupResult {
	const resultIds = new Set(
		messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
	);
	const declaredIds = new Set(
		messages
			.filter((message): message is AssistantMessage => message.role === 'assistant')
			.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []),
	);
	const removedToolResultIds: string[] = [];
	const removedToolCallIds: string[] = [];
	const cleaned = messages.flatMap((message): Message[] => {
		if (message.role === 'tool') {
			if (declaredIds.has(message.toolCallId)) {
				return [message];
			}
			removedToolResultIds.push(message.toolCallId);
			return [];
		}
		if (message.role !== 'assistant' || !message.toolCalls?.length) {
			return [message];
		}
		const validCalls = message.toolCalls.filter((call) => resultIds.has(call.id));
		for (const call of message.toolCalls) {
			if (!resultIds.has(call.id)) {
				removedToolCallIds.push(call.id);
			}
		}
		return [{ ...message, ...(validCalls.length > 0 ? { toolCalls: validCalls } : {}) }];
	});
	return { messages: cleaned, removedToolResultIds, removedToolCallIds };
}

/**
 * 根据最新检查点重建待压缩的有效历史。
 * @param sessionId 会话 ID。
 * @param messageStore 消息存储。
 * @returns 既有摘要和有效历史消息。
 */
/**
 * 生成增量会话摘要。
 * @param messages 本轮需要压缩的较早消息。
 * @param previousSummary 已有检查点摘要。
 * @param provider LLM Provider。
 * @param model 模型名。
 * @returns 非空摘要文本。
 */
export async function generateSummary(
	messages: Message[],
	previousSummary: string | null,
	provider: LLMProvider,
	model: string,
): Promise<string> {
	const prompt = [
		previousSummary ? `已有会话摘要：\n${previousSummary}` : '这是第一次压缩，没有已有摘要。',
		`需要纳入的新消息：\n${messagesToText(messages)}`,
		'请更新摘要，明确用户目标、约束、已完成工作、当前状态、失败尝试、相关文件和下一步。',
	].join('\n\n');
	const requestMessages: LLMMessage[] = [
		{ role: 'system', content: SUMMARY_SYSTEM_PROMPT },
		{ role: 'user', content: prompt },
	];
	let summary = '';
	let reasoningCharacters = 0;
	for await (const event of provider.chatCompletion({
		model,
		messages: requestMessages,
		stream: true,
		maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
		reasoningEffort: 'disabled',
	})) {
		if (event.type === 'textDelta') {
			summary += event.text;
		} else if (event.type === 'reasoningDelta') {
			reasoningCharacters += event.text.length;
		} else if (event.type === 'error') {
			throw new Error(`摘要生成失败：${event.error}`);
		}
	}
	if (!summary.trim()) {
		if (reasoningCharacters > 0) {
			throw new Error(`摘要生成失败：模型仅返回推理内容，未返回正文（reasoningCharacters=${reasoningCharacters} maxTokens=${SUMMARY_MAX_OUTPUT_TOKENS}）`);
		}
		throw new Error('摘要生成失败：模型返回空摘要');
	}
	return summary;
}

/**
 * 按请求预算执行自动、手动或溢出恢复压缩。
 * @param sessionId 会话 ID。
 * @param provider 当前运行使用的 Provider。
 * @param model 当前模型名。
 * @param config 压缩配置。
 * @param messageStore 消息存储。
 * @param eventBus 事件总线。
 * @param options 触发原因与完整请求 token。
 * @param todoStore 会话任务快照存储（可选；成功创建检查点时捕获活跃任务上下文）。
 * @returns 压缩结果。
 */
export async function compactIfNeeded(
	sessionId: string,
	provider: LLMProvider,
	model: string,
	config: CompactionConfig,
	messageStore: MessageStore,
	eventBus: EventBus,
	options: CompactOptions,
	todoStore?: SessionTodoStore,
): Promise<CompactionResult> {
	const thresholdTokens = calculateCompactionThreshold(config);
	const baseResult = { reason: options.reason, requestTokens: options.requestTokens, thresholdTokens };
	logger.log(`[上下文压缩] 入口 sessionId=${sessionId} reason=${options.reason} requestTokens=${options.requestTokens} threshold=${thresholdTokens}`);
	if (options.reason !== 'manual' && !config.autoEnabled) {
		logger.log(`[上下文压缩] 跳过 sessionId=${sessionId} 原因=自动压缩已关闭`);
		return { status: 'skipped', ...baseResult };
	}
	if (options.reason === 'automatic' && options.requestTokens < thresholdTokens) {
		logger.log(`[上下文压缩] 跳过 sessionId=${sessionId} 原因=请求低于阈值 requestTokens=${options.requestTokens} threshold=${thresholdTokens}`);
		return { status: 'skipped', ...baseResult };
	}

	const effective = messageStore.getEffectiveHistory(sessionId);
	const effectiveTokens = estimateMessages(effective.messages);
	const tailTokenBudget = calculateTailTokenBudget(config, effectiveTokens, options.reason);
	const split = selectMessages(effective.messages, tailTokenBudget);
	if (split.head.length === 0) {
		logger.log(`[上下文压缩] 跳过 sessionId=${sessionId} 原因=没有可摘要的历史 effectiveMessages=${effective.messages.length}`);
		return { status: 'skipped', ...baseResult };
	}

	const cleanup = sanitizeToolPairs(split.recent);
	logger.log(`[上下文压缩] 开始摘要 sessionId=${sessionId} reason=${options.reason} headMessages=${split.head.length} recentMessages=${split.recent.length} tailBudget=${tailTokenBudget} tailTokens=${estimateMessages(split.recent)} removedToolResults=${cleanup.removedToolResultIds.length} removedToolCalls=${cleanup.removedToolCallIds.length}`);
	eventBus.emit({ type: 'progress', sessionId, payload: { phase: 'compacting' } });
	try {
		const startedAt = Date.now();
		const summary = await generateSummary(split.head, effective.summary, provider, model);
		const todoContext = todoStore?.formatActiveContext(sessionId) ?? null;
		logger.log(`[上下文压缩] 捕获检查点任务上下文 sessionId=${sessionId} present=${todoContext ? '是' : '否'}`);
		messageStore.append(sessionId, {
			role: 'compaction',
			summary,
			recentContext: cleanup.messages,
			...(todoContext ? { todoContext } : {}),
		});
		eventBus.emit({ type: 'progress', sessionId, payload: { phase: 'compacted' } });
		if (options.reason !== 'manual') {
			eventBus.emit({
				type: 'run_state_change',
				sessionId,
				payload: { generation: 0, state: 'running', meta: { compaction: true, reason: options.reason } },
			});
		}
		logger.log(`[上下文压缩] 完成 sessionId=${sessionId} reason=${options.reason} 耗时=${Date.now() - startedAt}ms headMessages=${split.head.length} recentMessages=${cleanup.messages.length} requestTokens=${options.requestTokens} threshold=${thresholdTokens}`);
		return { status: 'compacted', ...baseResult };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`[上下文压缩] 失败 sessionId=${sessionId} reason=${options.reason} error=${message}`);
		return { status: 'failed', ...baseResult, error: message };
	}
}

/**
 * 将消息整理为摘要模型可读文本。
 * @param messages 需要摘要的消息。
 * @returns 格式化文本。
 */
function messagesToText(messages: Message[]): string {
	return messages.map((message) => {
		switch (message.role) {
			case 'system':
				return `[系统] ${message.content}`;
			case 'user':
				return `[用户] ${message.content}`;
			case 'assistant':
				return `[助手] ${message.content}${message.toolCalls?.length ? `\n[工具调用] ${message.toolCalls.map((call) => `${call.name}(${call.arguments})`).join(', ')}` : ''}`;
			case 'tool':
				return `[工具结果 ${message.toolCallId}] ${message.content.slice(0, 2000)}`;
			case 'compaction':
				return `[已有压缩] ${message.summary}`;
		}
	}).join('\n');
}
