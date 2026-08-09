/**
 * Doom Loop 检测器 - 检测连续相同工具调用模式。
 *
 * 参照 opencode processor.ts 的 doom loop 检测逻辑：
 * 检查最近 DOOM_LOOP_THRESHOLD 次工具调用是否为相同 tool + 相同 args。
 * 如果是，说明模型陷入了死循环，需要注入引导消息。
 */
import type { ToolCall } from '../memory/types';

const DOOM_LOOP_THRESHOLD = 3;

export interface DoomLoopResult {
	/** 是否检测到 doom loop */
	readonly isDoom: boolean;
	/** 重复的工具名（isDoom=true 时有值） */
	readonly tool?: string;
	/** 重复的参数（isDoom=true 时有值） */
	readonly args?: Record<string, unknown>;
}

export class DoomLoopDetector {
	private recentParts: Array<{ tool: string; args: Record<string, unknown> }> = [];

	/**
	 * 记录一次工具调用并检测 doom loop。
	 * 参照 opencode processor.ts: 检查最近 DOOM_LOOP_THRESHOLD 次调用是否全部相同。
	 */
	check(toolCall: ToolCall): DoomLoopResult {
		let parsedArgs: Record<string, unknown>;
		try {
			parsedArgs = JSON.parse(toolCall.arguments);
		} catch {
			parsedArgs = {};
		}

		this.recentParts.push({ tool: toolCall.name, args: parsedArgs });

		if (this.recentParts.length < DOOM_LOOP_THRESHOLD) {
			return { isDoom: false };
		}

		// 只看最近 DOOM_LOOP_THRESHOLD 条
		const recent = this.recentParts.slice(-DOOM_LOOP_THRESHOLD);
		const allSame = recent.every(
			(part) =>
				part.tool === recent[0].tool &&
				JSON.stringify(part.args) === JSON.stringify(recent[0].args),
		);

		if (allSame) {
			return {
				isDoom: true,
				tool: recent[0].tool,
				args: recent[0].args,
			};
		}

		return { isDoom: false };
	}

	/** 重置检测器（触发干预后调用）。 */
	reset(): void {
		this.recentParts = [];
	}

	/** 清除超过窗口的旧记录。 */
	prune(): void {
		if (this.recentParts.length > DOOM_LOOP_THRESHOLD * 2) {
			this.recentParts = this.recentParts.slice(-DOOM_LOOP_THRESHOLD);
		}
	}
}
