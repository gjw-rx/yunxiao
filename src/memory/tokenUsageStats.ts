/**
 * 本地 token 用量统计 - 从当前工作区会话归档扫描已落账调用，按模型与自然日/周/月聚合。
 *
 * 职责：
 * - 计算本机时区自然日、周一自然周、自然月的左闭右开时间边界；
 * - 按 provider+model 聚合 total/prompt/completion/reasoning 与缓存输入明细；
 * - 兼容旧归档：缺模型元数据归入"未知模型"、缺 token 账的消息忽略、损坏归档标记 partial。
 * 数据只来自 SessionFileStore 的受控扫描结果，不访问 provider 或云端账户。
 */
import type { ArchivedTokenRecord } from './sessionFileStore';
import * as logger from '../logger';

/** 用量统计粒度：自然日 / 自然周（周一为起点）/ 自然月。 */
export type UsageGranularity = 'day' | 'week' | 'month';

/** 固定内部 key：旧 token 账缺少模型标识时的"未知模型"分组。 */
export const UNKNOWN_MODEL_KEY = 'unknown';

/** 未知模型的中文展示标签。 */
export const UNKNOWN_MODEL_LABEL = '未知模型';

/** 聚合累计用的内部可变行（ModelUsageRow 只读版本的写端）。 */
interface MutableRow {
	provider_id: string;
	model_id: string;
	model_label: string;
	total_tokens: number;
	prompt_tokens: number;
	completion_tokens: number;
	reasoning_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	no_cache_tokens: number;
}

/** 模型维度的累计用量行（缓存明细为输入侧展示，不计入 total）。 */
export interface ModelUsageRow {
	/** Provider 标识（未知模型为 'unknown'）。 */
	readonly provider_id: string;
	/** 模型标识（未知模型为 'unknown'）。 */
	readonly model_id: string;
	/** 当时的非敏感模型展示名（缺省时为模型标识；未知模型为"未知模型"）。 */
	readonly model_label: string;
	/** 累计总量 = Σ tokenUsage.total_tokens（不含缓存明细重复累计）。 */
	readonly total_tokens: number;
	/** 累计输入 token。 */
	readonly prompt_tokens: number;
	/** 累计输出 token。 */
	readonly completion_tokens: number;
	/** 累计思考 token。 */
	readonly reasoning_tokens: number;
	/** 累计缓存读取 token（输入侧明细，不计入 total）。 */
	readonly cache_read_tokens: number;
	/** 累计缓存写入 token（输入侧明细，不计入 total）。 */
	readonly cache_write_tokens: number;
	/** 累计非缓存输入 token（输入侧明细，不计入 total）。 */
	readonly no_cache_tokens: number;
}

/** 用量统计只读结果（响应一次按粒度+参考日期的聚合请求）。 */
export interface TokenUsageStatsResult {
	/** 请求粒度。 */
	readonly granularity: UsageGranularity;
	/** 区间起点（ISO 字符串，本机时区自然边界）。 */
	readonly start: string;
	/** 区间终点（ISO 字符串，左闭右开）。 */
	readonly end: string;
	/** 区间内全部模型的总量。 */
	readonly total_tokens: number;
	/** 区间内全部模型的输入合计。 */
	readonly prompt_tokens: number;
	/** 区间内全部模型的输出合计。 */
	readonly completion_tokens: number;
	/** 是否有归档无法读取（结果为部分数据）。 */
	readonly partial: boolean;
	/** 按 total_tokens 降序的模型明细行。 */
	readonly models: readonly ModelUsageRow[];
}

/**
 * 计算本机时区自然边界的左闭右开区间。
 * - day：本地 00:00 至次日 00:00
 * - week：周一 00:00 至下周一 00:00
 * - month：当月第一天 00:00 至下月第一天 00:00
 * @param granularity 粒度
 * @param reference 参考日期（取本地年月日分量，忽略时分秒）
 * @returns 起止时间（Date）
 */
export function computeRange(granularity: UsageGranularity, reference: Date): { start: Date; end: Date } {
	const start = startOfPeriod(granularity, reference);
	const end = endOfPeriod(granularity, start);
	return { start, end };
}

/**
 * 计算粒度的起点（本机时区）。
 * @param granularity 粒度
 * @param reference 参考时间
 * @returns 起点 Date
 */
function startOfPeriod(granularity: UsageGranularity, reference: Date): Date {
	switch (granularity) {
		case 'day':
			return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
		case 'week': {
			// getDay()：周日=0，周一=1 … 周六=6 → 距周一偏移 = (getDay()+6)%7
			const weekdayOffset = (reference.getDay() + 6) % 7;
			const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
			start.setDate(start.getDate() - weekdayOffset);
			return new Date(start.getFullYear(), start.getMonth(), start.getDate());
		}
		case 'month':
			return new Date(reference.getFullYear(), reference.getMonth(), 1);
	}
}

/**
 * 计算粒度的终点（起点之后一个完整周期的 00:00）。
 * @param granularity 粒度
 * @param start 起点
 * @returns 终点 Date（不含）
 */
function endOfPeriod(granularity: UsageGranularity, start: Date): Date {
	switch (granularity) {
		case 'day':
			return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
		case 'week':
			return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
		case 'month':
			return new Date(start.getFullYear(), start.getMonth() + 1, 1);
	}
}

/**
 * 聚合扫描出的已落账 token 记录到指定粒度区间，输出按模型分组的统计结果。
 * 兼容规则：缺模型元数据→"未知模型"；缺 token 账的消息不进入扫描结果（天然忽略）；
 * 损坏归档在扫描阶段被跳过，这里根据 corruptSessions 数量标记 partial。
 * @param scan 扫描结果（记录 + 损坏会话列表 + 扫描会话数）
 * @param granularity 聚合粒度
 * @param reference 参考日期
 * @returns 统计结果（模型行按 total 降序）
 */
export function aggregateTokenUsage(
	scan: { readonly records: readonly ArchivedTokenRecord[]; readonly corruptSessions: readonly string[]; readonly scannedCount: number },
	granularity: UsageGranularity,
	reference: Date,
): TokenUsageStatsResult {
	const startedAt = Date.now();
	const { start, end } = computeRange(granularity, reference);
	const startMs = start.getTime();
	const endMs = end.getTime();

	const rows = new Map<string, MutableRow>();
	let total = 0;
	let prompt = 0;
	let completion = 0;
	let matched = 0;

	for (const record of scan.records) {
		const ts = new Date(record.timestamp).getTime();
		// 左闭右开：起点含、终点不含，避免跨桶重复计数
		if (ts < startMs || ts >= endMs) {
			continue;
		}
		matched++;
		const tu = record.tokenUsage;
		const providerId = tu.provider_id ?? UNKNOWN_MODEL_KEY;
		const modelId = tu.model_id ?? UNKNOWN_MODEL_KEY;
		// 统计键使用 provider+model 组合，避免不同 provider 的同名模型混淆
		const key = `${providerId}\u0000${modelId}`;
		const label = modelId === UNKNOWN_MODEL_KEY
			? UNKNOWN_MODEL_LABEL
			: (tu.model_label || modelId);
		const row = rows.get(key) ?? {
			provider_id: providerId,
			model_id: modelId,
			model_label: label,
			total_tokens: 0,
			prompt_tokens: 0,
			completion_tokens: 0,
			reasoning_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			no_cache_tokens: 0,
		};
		// total 以 provider 权威 total_tokens 为准；缓存明细仅作为输入侧构成，不再次计入 total
		row.total_tokens += tu.total_tokens ?? 0;
		row.prompt_tokens += tu.prompt_tokens ?? 0;
		row.completion_tokens += tu.completion_tokens ?? 0;
		row.reasoning_tokens += tu.reasoning_tokens ?? 0;
		row.cache_read_tokens += tu.cache_read_tokens ?? 0;
		row.cache_write_tokens += tu.cache_write_tokens ?? 0;
		row.no_cache_tokens += tu.no_cache_tokens ?? 0;
		rows.set(key, row);
		total += tu.total_tokens ?? 0;
		prompt += tu.prompt_tokens ?? 0;
		completion += tu.completion_tokens ?? 0;
	}

	const models: ModelUsageRow[] = [...rows.values()].sort((a, b) => b.total_tokens - a.total_tokens);
	const partial = scan.corruptSessions.length > 0;
	const result: TokenUsageStatsResult = {
		granularity,
		start: start.toISOString(),
		end: end.toISOString(),
		total_tokens: total,
		prompt_tokens: prompt,
		completion_tokens: completion,
		partial,
		models,
	};
	logger.log(
		`[TokenUsageStats] 聚合完成 granularity=${granularity} start=${result.start} end=${result.end} 扫描会话=${scan.scannedCount} 账目=${scan.records.length} 命中=${matched} 模型数=${models.length} 耗时=${Date.now() - startedAt}ms partial=${partial} 损坏会话=${scan.corruptSessions.length}`,
	);
	return result;
}