/**
 * 重复调用检测器 - 跟踪连续相同工具调用，达到阈值时触发干预。
 *
 * key = tool + JSON.stringify(args)（sorted keys），仅跟踪"连续"重复。
 * 不同工具或不同参数调用会重置计数器。
 */
export class ToolCallTracker {
	private lastKey: string | null = null;
	private count = 0;

	/**
	 * 检查当前调用是否为连续重复，返回连续重复次数。
	 * 相同 key → 计数递增；不同 key → 重置为 1。
	 */
	check(tool: string, args: Record<string, unknown>): number {
		const key = this.buildKey(tool, args);
		if (key === this.lastKey) {
			this.count++;
		} else {
			this.lastKey = key;
			this.count = 1;
		}
		return this.count;
	}

	/** 重置计数器（触发干预后调用，避免下一轮立即再次触发）。 */
	reset(): void {
		this.lastKey = null;
		this.count = 0;
	}

	/** 构建稳定 key：tool + JSON.stringify(args)（sorted keys）。 */
	private buildKey(tool: string, args: Record<string, unknown>): string {
		return tool + ':' + JSON.stringify(args, Object.keys(args).sort());
	}
}
