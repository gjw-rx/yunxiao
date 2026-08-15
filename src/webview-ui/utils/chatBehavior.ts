/**
 * 对话界面交互工具。
 *
 * 职责：提供输入框命令片段识别与消息列表自动跟随的纯函数，便于独立验证。
 */

/** Slash 命令片段在输入文本中的位置。 */
export interface SlashCommandToken {
	/** 当前光标前的查询文本，不含斜杠。 */
	readonly query: string;
	/** 斜杠在原始文本中的起始位置。 */
	readonly start: number;
	/** 命令片段后的第一个位置，用于替换完整片段。 */
	readonly end: number;
}

/** 可用于判断滚动位置的容器尺寸。 */
export interface ScrollMetrics {
	/** 容器当前垂直滚动距离。 */
	readonly scrollTop: number;
	/** 容器可视高度。 */
	readonly clientHeight: number;
	/** 容器内容总高度。 */
	readonly scrollHeight: number;
}

/**
 * 查找光标所在的 Slash 命令片段。
 *
 * Slash 必须位于输入开头或空白字符之后；选中命令时使用完整片段范围，避免保留残缺尾部。
 *
 * @param value 输入框完整文本
 * @param cursorPos 光标位置
 * @returns 可触发的命令片段；不存在时返回 null
 */
export function findSlashCommandToken(value: string, cursorPos: number): SlashCommandToken | null {
	const cursor = Math.max(0, Math.min(cursorPos, value.length));
	const start = value.lastIndexOf('/', cursor - 1);
	if (start < 0 || (start > 0 && !/\s/.test(value.charAt(start - 1)))) {
		return null;
	}

	const whitespaceIndex = value.slice(start).search(/\s/);
	const end = whitespaceIndex < 0 ? value.length : start + whitespaceIndex;
	if (cursor > end) {
		return null;
	}

	return { query: value.slice(start + 1, cursor), start, end };
}

/**
 * 判断消息列表是否仍处于底部附近。
 *
 * @param metrics 消息列表的滚动尺寸
 * @param threshold 允许的底部误差（像素）
 * @returns 位于底部附近时返回 true
 */
export function isNearScrollBottom(metrics: ScrollMetrics, threshold = 32): boolean {
	return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}
