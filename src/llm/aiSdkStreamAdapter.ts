/**
 * AI SDK 流适配器 - 将 streamText 的 fullStream part 归一化为现有 LLMEvent 序列。
 *
 * 映射规则（见 design.md Decision 4）：
 * - text-delta            → textDelta
 * - reasoning-delta       → reasoningDelta
 * - tool-call             → toolCall（完整 tool call，arguments 为 JSON 序列化字符串）
 * - finish                → 一次权威 usage 事件 + finish 事件
 * - error / abort         → 终止当前生成，error 事件或正常结束
 *
 * 权威 usage：仅使用最终 finish part 的 totalUsage，忽略中间 finish-step 的 step usage，
 * 保证每次 LLM 调用最多产生一条 usage 事件。
 */
import type { TextStreamPart, ToolSet, LanguageModelUsage } from 'ai';
import type { LLMEvent, UsageEvent } from './types';

/** 归一化的 usage 提取结果 */
export interface NormalizedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly reasoningTokens?: number;
	readonly totalTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
}

/**
 * 将 AI SDK fullStream part 转换为一条或多条 LLMEvent。
 * 状态通过回调闭包维护：reasoning 累计供 usage 缺失时估算；usage 保证只发一次。
 */
export function mapStreamPart<T extends ToolSet>(
	part: TextStreamPart<T>,
	state: {
		/** 已发出 usage 事件的标记，保证每次调用只发一条权威 usage */
		usageEmitted: boolean;
	},
): LLMEvent[] {
	switch (part.type) {
		case 'text-delta':
			return [{ type: 'textDelta', text: part.text }];
		case 'reasoning-delta':
			return [{ type: 'reasoningDelta', text: part.text }];
		case 'tool-call': {
			const argumentsText = part.input === undefined ? '' : JSON.stringify(part.input);
			return [{ type: 'toolCall', id: part.toolCallId, name: part.toolName, arguments: argumentsText }];
		}
		case 'finish': {
			const events: LLMEvent[] = [];
			if (!state.usageEmitted && part.totalUsage) {
				state.usageEmitted = true;
				events.push(usageToLLMEvent(part.totalUsage));
			}
			events.push({ type: 'finish', reason: mapFinishReason(part.finishReason) });
			return events;
		}
		case 'error':
			return [{
				type: 'error',
				error: part.error instanceof Error ? part.error.message : String(part.error),
			}];
		case 'abort':
			// 取消：正常结束生成（与 legacy 的流中断行为对齐），不产生 finish/error
			return [];
		default:
			// tool-input-* / start-step / finish-step / start / raw / source / file 等不映射到现有协议
			return [];
	}
}

/** 将 AI SDK totalUsage 归一化为本地 usage 事件（含 cache 明细） */
function usageToLLMEvent(usage: LanguageModelUsage): UsageEvent {
	const normalized = normalizeUsage(usage);
	return {
		type: 'usage',
		inputTokens: normalized.inputTokens,
		outputTokens: normalized.outputTokens,
		...(normalized.reasoningTokens !== undefined ? { reasoningTokens: normalized.reasoningTokens } : {}),
		...(normalized.totalTokens !== undefined ? { totalTokens: normalized.totalTokens } : {}),
		...(normalized.cacheReadTokens !== undefined ? { cacheReadTokens: normalized.cacheReadTokens } : {}),
		...(normalized.cacheWriteTokens !== undefined ? { cacheWriteTokens: normalized.cacheWriteTokens } : {}),
	};
}

/**
 * 归一化 AI SDK usage 为本地 usage 字段。
 * - inputTokens/outputTokens 缺失时按 0 处理（调用方会兜底估算）
 * - reasoningTokens 取 outputTokenDetails.reasoningTokens
 * - cacheReadTokens 取 inputTokenDetails.cacheReadTokens；cacheWriteTokens 取 inputTokenDetails.cacheWriteTokens
 * - totalTokens 优先取 totalTokens，缺失时由调用方按 input+output 兜底
 */
export function normalizeUsage(usage: LanguageModelUsage): NormalizedUsage {
	const inputTokens = usage.inputTokens ?? 0;
	const outputTokens = usage.outputTokens ?? 0;
	const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
	const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
	const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
	return {
		inputTokens,
		outputTokens,
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
	};
}

/** 将 AI SDK FinishReason 映射到本地 finish reason */
function mapFinishReason(
	reason: string,
): 'stop' | 'tool_use' | 'length' {
	switch (reason) {
		case 'stop':
			return 'stop';
		case 'tool-calls':
			return 'tool_use';
		case 'length':
			return 'length';
		default:
			// content-filter / error / other 一律按 stop 处理（与 legacy mapFinishReason 一致）
			return 'stop';
	}
}
