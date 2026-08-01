/**
 * 工具结果回传协议 - POST /api/agent/invoke/tool_result，返回 SSE 续流。
 *
 * 续流模型（Design B）：本地执行完工具后，POST /tool_result，云端注入工具结果、
 * 重新 ainvoke，并将续流作为本次 HTTP 响应的 SSE 流返回。本地读取该流，事件复用
 * sseHandler 解析。流中可能再次出现 tool_call（进入下一轮），或 content 后结束（轮次完成）。
 *
 * 连接级重试：仅在网络错误 / 5xx（尚未开始流式传输）时按指数退避重试；
 * 4xx 立即失败；流式传输开始后不再重试。取消经 AbortController。
 */
import { SseStreamParser, type SseCallbacks } from './sseHandler';
import type { ToolResult } from '../core/types';
import { ProtocolError } from '../core/errors';

export interface StreamToolResultOptions {
	readonly baseUrl: string;
	/** 连接级最大尝试次数（含首次），默认 3。 */
	readonly maxRetries?: number;
	/** 可注入的 fetch 实现（测试用）。 */
	readonly fetchImpl?: typeof fetch;
	/** 可注入的延迟函数（测试用，避免真实退避等待）。 */
	readonly sleep?: (ms: number) => Promise<void>;
}

/** 续流回调（复用 SseCallbacks，含流级 onEnd/onError）。 */
export type ToolResultCallbacks = SseCallbacks;

const DEFAULT_MAX_RETRIES = 3;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
	const base = 500 * Math.pow(2, attempt - 1);
	return Math.round(base * (0.5 + Math.random()));
}

async function readErrorBody(res: Response): Promise<string> {
	try {
		const json = (await res.json()) as { success?: boolean; error?: string };
		return json.error ?? `服务返回状态码 ${res.status}`;
	} catch {
		return `服务返回状态码 ${res.status}`;
	}
}

/** 读取 SSE 流并喂给 parser，支持取消。 */
async function pumpSse(
	body: ReadableStream<Uint8Array>,
	callbacks: SseCallbacks,
	controller: AbortController
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	const parser = new SseStreamParser(callbacks);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			parser.feed(decoder.decode(value, { stream: true }));
			if (controller.signal.aborted) {
				break;
			}
		}
		if (!controller.signal.aborted) {
			parser.flush();
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// 忽略取消异常
		}
	}
}

/**
 * 提交工具结果并读取续流。返回 AbortController 用于取消。
 * 流正常结束触发 onEnd；连接失败/4xx 触发 onError。
 */
export function streamToolResult(
	result: ToolResult,
	sessionId: string,
	options: StreamToolResultOptions,
	callbacks: ToolResultCallbacks
): AbortController {
	const controller = new AbortController();
	void runStreamToolResult(result, sessionId, options, callbacks, controller);
	return controller;
}

async function runStreamToolResult(
	result: ToolResult,
	sessionId: string,
	options: StreamToolResultOptions,
	callbacks: ToolResultCallbacks,
	controller: AbortController
): Promise<void> {
	const {
		baseUrl,
		maxRetries = DEFAULT_MAX_RETRIES,
		fetchImpl = fetch,
		sleep = defaultSleep,
	} = options;

	const url = `${baseUrl}/api/agent/invoke/tool_result`;
	const body = JSON.stringify({ session_id: sessionId, ...result });

	let attempt = 0;
	while (true) {
		attempt++;
		try {
			const res = await fetchImpl(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				signal: controller.signal,
			});
			if (controller.signal.aborted) {
				return;
			}

			// 4xx：客户端错误，立即失败不重试
			if (res.status >= 400 && res.status < 500) {
				callbacks.onError?.(new ProtocolError(await readErrorBody(res), res.status));
				return;
			}
			// 5xx：服务端错误，可重试
			if (res.status >= 500) {
				throw new ProtocolError(`服务端错误 ${res.status}`, res.status);
			}
			if (!res.body) {
				callbacks.onError?.(new ProtocolError('tool_result 响应无 body'));
				return;
			}

			// 流式传输开始，不再重试
			await pumpSse(res.body, callbacks, controller);
			if (!controller.signal.aborted) {
				callbacks.onEnd?.();
			}
			return;
		} catch (err) {
			if (controller.signal.aborted) {
				return;
			}
			// 4xx ProtocolError 不重试
			if (err instanceof ProtocolError && err.statusCode !== undefined && err.statusCode < 500) {
				callbacks.onError?.(err);
				return;
			}
			if (attempt < maxRetries) {
				await sleep(backoffMs(attempt));
				continue;
			}
			const reason = err instanceof Error ? err.message : String(err);
			callbacks.onError?.(
				new ProtocolError(`tool_result 提交失败（已重试 ${attempt} 次）: ${reason}`)
			);
			return;
		}
	}
}
