/**
 * SSE 事件处理器 - 从 aiClient.ts 抽出的流式事件解析与分发。
 *
 * 支持事件类型：
 * - content / thought / tool_start / tool_end（原有）
 * - tool_call / plan / progress（Phase 1 新增）
 * - { success:false } 错误信封
 *
 * 半包缓冲由 SseStreamParser 按 \n\n 切分完整事件块后交给 handleSseBlock。
 */
import type {
	ToolCallEventData,
	ToolStartEventData,
	ToolEndEventData,
	PlanEventData,
	ProgressEventData,
} from '../core/types';

/** SSE 事件回调。所有回调可选，未注册的事件类型被忽略。 */
export interface SseCallbacks {
	onContent?: (text: string) => void;
	onThought?: (text: string) => void;
	onToolStart?: (data: ToolStartEventData) => void;
	onToolEnd?: (data: ToolEndEventData) => void;
	onToolCall?: (event: ToolCallEventData) => void;
	onPlan?: (event: PlanEventData) => void;
	onProgress?: (event: ProgressEventData) => void;
	/** 流级错误（网络/服务端/{success:false} 信封）。 */
	onError?: (err: Error) => void;
	/** 流正常结束（reader done）。 */
	onEnd?: () => void;
}

type AnyRecord = Record<string, unknown>;

/** 解析一个完整的 SSE 事件块（已按 \n\n 切分）。 */
export function handleSseBlock(block: string, cbs: SseCallbacks): void {
	for (const line of block.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data:')) {
			continue;
		}
		const jsonStr = trimmed.slice(5).trim();
		if (!jsonStr) {
			continue;
		}
		let parsed: AnyRecord;
		try {
			parsed = JSON.parse(jsonStr) as AnyRecord;
		} catch {
			// 非 JSON 行，忽略
			continue;
		}

		// 流中错误信封：{ success: false, error: "..." }
		if (parsed.success === false) {
			cbs.onError?.(new Error((parsed.error as string) ?? '流式请求失败'));
			return;
		}

		const evtType = parsed.type as string | undefined;
		const evtData = parsed.data;
		const dataIsObject = typeof evtData === 'object' && evtData !== null;

		switch (evtType) {
			case 'content':
				if (typeof evtData === 'string') {
					cbs.onContent?.(evtData);
				}
				break;
			case 'thought':
				if (typeof evtData === 'string') {
					cbs.onThought?.(evtData);
				}
				break;
			case 'tool_start': {
				if (dataIsObject) {
					const d = evtData as AnyRecord;
					if (typeof d.run_id === 'string' && typeof d.name === 'string') {
						cbs.onToolStart?.({
							run_id: d.run_id,
							name: d.name,
							input: (d.input as Record<string, unknown>) ?? {},
							tool_call_id: (d.tool_call_id as string | null) ?? null,
						});
					}
				}
				break;
			}
			case 'tool_end': {
				if (dataIsObject) {
					const d = evtData as AnyRecord;
					if (typeof d.run_id === 'string' && typeof d.name === 'string') {
						cbs.onToolEnd?.({
							run_id: d.run_id,
							name: d.name,
							output: (d.output as string) ?? '',
							tool_call_id: (d.tool_call_id as string | null) ?? null,
						});
					}
				}
				break;
			}
			case 'tool_call': {
				// Phase 3：data 为对象数组，一次包含本轮全部 pending 本地工具调用
				const arr = Array.isArray(evtData) ? evtData : null;
				if (!arr) {
					break;
				}
				for (const item of arr) {
					const d = item as AnyRecord;
					if (typeof d.call_id === 'string' && typeof d.tool === 'string') {
						cbs.onToolCall?.({
							call_id: d.call_id as string,
							tool: d.tool as string,
							args: (d.args as ToolCallEventData['args']) ?? {},
							site: (d.site as ToolCallEventData['site']) ?? 'local',
							require_approval: d.require_approval as boolean | undefined,
						});
					}
				}
				break;
			}
			case 'plan': {
				const d = (dataIsObject ? (evtData as AnyRecord) : parsed) as AnyRecord;
				if (Array.isArray(d.steps)) {
					cbs.onPlan?.({ steps: d.steps as string[] });
				}
				break;
			}
			case 'progress': {
				const d = (dataIsObject ? (evtData as AnyRecord) : parsed) as AnyRecord;
				if (typeof d.message === 'string') {
					cbs.onProgress?.({
						message: d.message,
						current: d.current as number | undefined,
						total: d.total as number | undefined,
					});
				}
				break;
			}
			default:
				// 未知事件类型，忽略
				break;
		}
	}
}

/**
 * 增量 SSE 流解析器：维护跨块缓冲，按 \n\n 切分完整事件块。
 * feed() 每次传入一个 chunk，flush() 在流结束时处理剩余缓冲。
 */
export class SseStreamParser {
	private buffer = '';

	constructor(private readonly cbs: SseCallbacks) { }

	/** 投喂一个文本块，自动切分并分发完整事件。 */
	feed(chunk: string): void {
		this.buffer += chunk;
		let sep: number;
		while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
			const block = this.buffer.slice(0, sep);
			this.buffer = this.buffer.slice(sep + 2);
			handleSseBlock(block, this.cbs);
		}
	}

	/** 流结束时处理缓冲区剩余内容。 */
	flush(): void {
		if (this.buffer.trim()) {
			handleSseBlock(this.buffer, this.cbs);
		}
		this.buffer = '';
	}
}
