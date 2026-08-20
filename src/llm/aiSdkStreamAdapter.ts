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
import * as logger from '../logger';

/** 归一化的 usage 提取结果 */
export interface NormalizedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly reasoningTokens?: number;
	readonly totalTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly noCacheTokens?: number;
}

/** 被拒绝的可选 usage 细分（用于诊断日志，不污染账本） */
export interface UsageRejection {
	/** 被拒绝的字段名 */
	readonly field: string;
	/** 原始值（可能为 NaN/Infinity） */
	readonly value: number;
	/** 拒绝原因（中文，不含提示词） */
	readonly reason: string;
}

/** 归一化结果：有效字段 + 被拒绝细分列表 */
export interface NormalizedUsageResult {
	readonly usage: NormalizedUsage;
	readonly rejected: UsageRejection[];
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
			// finishReason='error'：AI SDK 在流内 error part 之后仍会补发一次顶层 finish 收尾（无更多 step 时），
			// 但既然已发出 error 事件，不应再发成功 finish（design.md：出错后停止该次调用，不发出成功 finish）
			if (part.finishReason === 'error') {
				return [];
			}
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

/** 将 AI SDK totalUsage 归一化为本地 usage 事件（含 cache 明细，被拒绝细分打印诊断日志） */
function usageToLLMEvent(usage: LanguageModelUsage): UsageEvent {
	const { usage: normalized, rejected } = normalizeUsage(usage);
	for (const r of rejected) {
		logger.log(`[AISdkStreamAdapter] usage 细分无效已省略 field=${r.field} value=${r.value} reason=${r.reason}`);
	}
	return {
		type: 'usage',
		inputTokens: normalized.inputTokens,
		outputTokens: normalized.outputTokens,
		...(normalized.reasoningTokens !== undefined ? { reasoningTokens: normalized.reasoningTokens } : {}),
		...(normalized.totalTokens !== undefined ? { totalTokens: normalized.totalTokens } : {}),
		...(normalized.cacheReadTokens !== undefined ? { cacheReadTokens: normalized.cacheReadTokens } : {}),
		...(normalized.cacheWriteTokens !== undefined ? { cacheWriteTokens: normalized.cacheWriteTokens } : {}),
		...(normalized.noCacheTokens !== undefined ? { noCacheTokens: normalized.noCacheTokens } : {}),
	};
}

/**
 * 归一化 AI SDK usage 为本地 usage 字段（含字段级校验）。
 * - inputTokens/outputTokens 须为有限非负整数，缺失/无效时按 0 处理（调用方会兜底估算）
 * - reasoningTokens 取 outputTokenDetails.reasoningTokens，须有限非负整数且 ≤ outputTokens
 * - cacheReadTokens 取 inputTokenDetails.cacheReadTokens，须有限非负整数且 ≤ inputTokens
 * - noCacheTokens 取 inputTokenDetails.noCacheTokens，须有限非负整数且 ≤ inputTokens
 * - cacheWriteTokens 取 inputTokenDetails.cacheWriteTokens，须有限非负整数
 * - totalTokens 有效则原样保留（AI SDK 允许 ≠ input+output）；缺失/无效时为 undefined（调用方按 input+output 回退）
 * - 无效的可选细分一律省略并计入 rejected（不污染账本）
 */
export function normalizeUsage(usage: LanguageModelUsage): NormalizedUsageResult {
	const rejected: UsageRejection[] = [];

	const inputTokens = validateRequired(usage.inputTokens, 'inputTokens', rejected);
	const outputTokens = validateRequired(usage.outputTokens, 'outputTokens', rejected);

	const reasoningTokens = validateOptional(
		usage.outputTokenDetails?.reasoningTokens,
		'reasoningTokens',
		outputTokens,
		rejected,
	);
	const cacheReadTokens = validateOptional(
		usage.inputTokenDetails?.cacheReadTokens,
		'cacheReadTokens',
		inputTokens,
		rejected,
	);
	const noCacheTokens = validateOptional(
		usage.inputTokenDetails?.noCacheTokens,
		'noCacheTokens',
		inputTokens,
		rejected,
	);
	const cacheWriteTokens = validateOptional(
		usage.inputTokenDetails?.cacheWriteTokens,
		'cacheWriteTokens',
		Number.MAX_SAFE_INTEGER,
		rejected,
	);

	let totalTokens: number | undefined;
	if (usage.totalTokens === undefined) {
		// 缺失：由调用方按 input+output 回退
		totalTokens = undefined;
	} else if (!isValidCount(usage.totalTokens)) {
		rejected.push({ field: 'totalTokens', value: usage.totalTokens, reason: '非有限非负整数' });
	} else {
		totalTokens = usage.totalTokens;
	}

	return {
		usage: {
			inputTokens,
			outputTokens,
			...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
			...(totalTokens !== undefined ? { totalTokens } : {}),
			...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
			...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
			...(noCacheTokens !== undefined ? { noCacheTokens } : {}),
		},
		rejected,
	};
}

/** 校验必填计数：须为有限非负整数；缺失/无效时按 0 兜底并记录拒绝（调用方会估算） */
function validateRequired(
	value: number | undefined,
	field: string,
	rejected: UsageRejection[],
): number {
	if (value === undefined || !isValidCount(value)) {
		rejected.push({ field, value: value ?? Number.NaN, reason: '非有限非负整数' });
		return 0;
	}
	return value;
}

/** 校验可选细分：须为有限非负整数且不超过上限；无效时返回 undefined 并记录拒绝 */
function validateOptional(
	value: number | undefined,
	field: string,
	upperBound: number,
	rejected: UsageRejection[],
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isValidCount(value)) {
		rejected.push({ field, value, reason: '非有限非负整数' });
		return undefined;
	}
	if (value > upperBound) {
		rejected.push({ field, value, reason: `超过上限 ${upperBound}` });
		return undefined;
	}
	return value;
}

/** 是否为有限非负整数 */
function isValidCount(value: number): boolean {
	return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
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
