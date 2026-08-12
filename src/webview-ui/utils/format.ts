/**
 * 展示格式化工具（从旧 chatPanel.ts `_getJs()` 迁移）。
 *
 * 职责：数字千分位、token 用量明细、相对时间与历史 token 聚合等纯展示逻辑。
 */
import type { SessionTokenPayload, TokenUsageDetail } from '../protocol';

/** 格式化数字（千分位）。 */
export function formatNumber(n: number): string {
	if (typeof n !== 'number' || n === 0) return '0';
	return n.toLocaleString('en-US');
}

/**
 * 按绝对 token 数格式化单次调用用量（不展示伪上下文百分比）。
 *
 * @param usage 单次调用用量
 * @returns 展示文本与悬浮说明
 */
export function formatTokenUsage(usage: TokenUsageDetail | undefined): { text: string; title: string } {
	const total = usage && Number.isFinite(usage.total_tokens) ? (usage.total_tokens as number) : 0;
	if (total <= 0) {
		return { text: '--', title: 'Token 用量不可用' };
	}
	const prompt = usage && Number.isFinite(usage.prompt_tokens) ? (usage.prompt_tokens as number) : 0;
	const completion = usage && Number.isFinite(usage.completion_tokens) ? (usage.completion_tokens as number) : 0;
	const parts = [`输入 ${formatNumber(prompt)}`, `输出 ${formatNumber(completion)}`];
	if (usage && Number.isFinite(usage.reasoning_tokens) && (usage.reasoning_tokens as number) > 0) {
		parts.push(`思考 ${formatNumber(usage.reasoning_tokens as number)}`);
	}
	if (usage && Number.isFinite(usage.no_cache_tokens) && (usage.no_cache_tokens as number) > 0) {
		parts.push(`非缓存输入 ${formatNumber(usage.no_cache_tokens as number)}`);
	}
	if (usage && Number.isFinite(usage.cache_read_tokens) && (usage.cache_read_tokens as number) > 0) {
		parts.push(`缓存读 ${formatNumber(usage.cache_read_tokens as number)}`);
	}
	if (usage && Number.isFinite(usage.cache_write_tokens) && (usage.cache_write_tokens as number) > 0) {
		parts.push(`缓存写 ${formatNumber(usage.cache_write_tokens as number)}`);
	}
	return {
		text: formatNumber(total),
		title: `本次 Token 消耗：${formatNumber(total)}；${parts.join('，')}（缓存为输入侧明细，不计入总量）`,
	};
}

/** 将 ISO 时间格式化为相对时间（刚刚/x 分钟前/x 小时前/x 天前/日期）。 */
export function formatRelativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const minute = 60000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (diff < minute) return '刚刚';
	if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
	if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
	if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
	return new Date(iso).toLocaleDateString();
}

/** 渲染会话级累计条：总量 + 四类拆分 + 缓存输入明细；估算项带"约"。 */
export function formatSessionTokenUsage(payload: SessionTokenPayload | null): {
	total: string;
	items: { label: string; val: string; approx: boolean }[];
	title: string;
} {
	const total = payload?.total_tokens || 0;
	const b = payload?.breakdown || { reasoning: 0, tool_calls: 0, model_output: 0, user_input: 0, context: 0 };
	const items: { label: string; val: number; approx: boolean }[] = [
		{ label: '思考', val: b.reasoning || 0, approx: true },
		{ label: '工具', val: b.tool_calls || 0, approx: true },
		{ label: '回复', val: b.model_output || 0, approx: true },
		{ label: '输入', val: b.user_input || 0, approx: true },
		{ label: '上下文(输入估)', val: b.context || 0, approx: true },
	];
	// 缓存为输入侧明细，仅在有数据时展示；真实 usage 值不带"约"
	if ((payload?.no_cache_tokens || 0) > 0) {
		items.push({ label: '非缓存输入', val: payload?.no_cache_tokens || 0, approx: false });
	}
	if ((payload?.cache_read_tokens || 0) > 0) {
		items.push({ label: '缓存读', val: payload?.cache_read_tokens || 0, approx: false });
	}
	if ((payload?.cache_write_tokens || 0) > 0) {
		items.push({ label: '缓存写', val: payload?.cache_write_tokens || 0, approx: false });
	}
	return {
		total: formatNumber(total),
		items: items.map((it) => ({ label: it.label, val: (it.approx ? '约' : '') + formatNumber(it.val), approx: it.approx })),
		title: `会话累计 Token：${formatNumber(total)}；四类不含上下文，缓存为输入侧明细不计入总量`,
	};
}
