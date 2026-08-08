/**
 * 只读工具结果缓存 - 单次 AgentLoop.run() 内缓存 read 工具结果。
 *
 * key = tool + JSON.stringify(args)（sorted keys），仅缓存 status=success 的结果。
 * 生命周期 = 单次 run，不跨会话。
 */
import type { ToolResult } from '../core/types';

export class ToolResultCache {
	private readonly cache = new Map<string, ToolResult>();

	/** 构建稳定 key。 */
	private buildKey(tool: string, args: Record<string, unknown>): string {
		return tool + ':' + JSON.stringify(args, Object.keys(args).sort());
	}

	/** 检查缓存是否命中。 */
	has(tool: string, args: Record<string, unknown>): boolean {
		return this.cache.has(this.buildKey(tool, args));
	}

	/** 获取缓存结果，未命中返回 undefined。 */
	get(tool: string, args: Record<string, unknown>): ToolResult | undefined {
		return this.cache.get(this.buildKey(tool, args));
	}

	/** 存入缓存（仅缓存 success 结果）。 */
	set(tool: string, args: Record<string, unknown>, result: ToolResult): void {
		if (result.status !== 'success') {
			return;
		}
		this.cache.set(this.buildKey(tool, args), result);
	}
}
