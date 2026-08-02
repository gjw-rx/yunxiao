import * as assert from 'assert';
import { streamToolResult } from '../../protocol/toolCallProtocol';
import { ProtocolError } from '../../core/errors';
import type { ToolResult, ToolCallEventData } from '../../core/types';
import type { SseCallbacks } from '../../protocol/sseHandler';

function sseResponse(status: number, chunks: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) {
				controller.enqueue(encoder.encode(c));
			}
			controller.close();
		},
	});
	return { status, body: stream, json: async () => ({}) } as unknown as Response;
}

function errorResponse(status: number, error: string): Response {
	return { status, json: async () => ({ success: false, error }) } as unknown as Response;
}

class FakeFetch {
	private queue: (Response | Error)[] = [];
	readonly calls: { url: string; body: string }[] = [];
	enqueue(...items: (Response | Error)[]): void {
		this.queue.push(...items);
	}
	readonly fetch = async (
		url: string | URL | Request,
		init?: RequestInit
	): Promise<Response> => {
		this.calls.push({ url: url.toString(), body: (init?.body as string) ?? '' });
		const item = this.queue.shift();
		if (!item) {
			throw new Error('no queued response');
		}
		if (item instanceof Error) {
			throw item;
		}
		return item;
	};
}

const RESULTS: ToolResult[] = [{ call_id: 'c1', status: 'success', result: 'content' }];
const BASE = { baseUrl: 'http://svc', sleep: async () => {} };

function makeCallbacks(): SseCallbacks & {
	content: string[];
	toolCalls: ToolCallEventData[];
	ended: boolean;
	errors: Error[];
} {
	const content: string[] = [];
	const toolCalls: ToolCallEventData[] = [];
	let ended = false;
	const errors: Error[] = [];
	return {
		content,
		toolCalls,
		get ended() {
			return ended;
		},
		errors,
		onContent: (t) => content.push(t),
		onToolCall: (e) => toolCalls.push(e),
		onEnd: () => {
			ended = true;
		},
		onError: (e) => errors.push(e),
	};
}

describe('streamToolResult', () => {
	it('posts to /tool_result and pumps the SSE continuation stream', async () => {
		// Arrange
		const ff = new FakeFetch();
		ff.enqueue(
			sseResponse(200, [
				'data: {"type":"content","data":"summary"}\n\n',
			])
		);
		const cbs = makeCallbacks();
		// Act
		const controller = streamToolResult(RESULTS, 's1', { ...BASE, fetchImpl: ff.fetch }, cbs);
		await waitForEnd(cbs);
		// Assert
		assert.deepStrictEqual(cbs.content, ['summary']);
		assert.strictEqual(cbs.ended, true);
		assert.strictEqual(cbs.errors.length, 0);
		assert.strictEqual(ff.calls.length, 1);
		assert.strictEqual(ff.calls[0].url, 'http://svc/api/agent/invoke/tool_result');
		assert.ok(ff.calls[0].body.includes('"results"'));
		assert.ok(ff.calls[0].body.includes('"call_id":"c1"'));
		assert.ok(ff.calls[0].body.includes('"session_id":"s1"'));
		void controller;
	});

	it('forwards a tool_call event in the continuation stream', async () => {
		// Arrange
		const ff = new FakeFetch();
		ff.enqueue(
			sseResponse(200, [
				'data: {"type":"tool_call","data":[{"call_id":"c2","tool":"fs.read_file","args":{"path":"b.ts"},"site":"local"}]}\n\n',
			])
		);
		const cbs = makeCallbacks();
		// Act
		streamToolResult(RESULTS, 's1', { ...BASE, fetchImpl: ff.fetch }, cbs);
		await waitForEnd(cbs);
		// Assert
		assert.strictEqual(cbs.toolCalls.length, 1);
		assert.strictEqual(cbs.toolCalls[0].call_id, 'c2');
	});

	it('does not retry on 4xx and reports error', async () => {
		// Arrange
		const ff = new FakeFetch();
		ff.enqueue(errorResponse(400, 'bad call_id'));
		const cbs = makeCallbacks();
		// Act
		streamToolResult(RESULTS, 's1', { ...BASE, fetchImpl: ff.fetch }, cbs);
		await waitForError(cbs);
		// Assert
		assert.strictEqual(cbs.errors.length, 1);
		assert.ok(cbs.errors[0] instanceof ProtocolError);
		assert.strictEqual(ff.calls.length, 1);
		assert.strictEqual(cbs.ended, false);
	});

	it('retries on 5xx then streams successfully', async () => {
		// Arrange
		const ff = new FakeFetch();
		ff.enqueue(
			errorResponse(503, 'unavailable'),
			sseResponse(200, ['data: {"type":"content","data":"ok"}\n\n'])
		);
		const cbs = makeCallbacks();
		// Act
		streamToolResult(RESULTS, 's1', { ...BASE, fetchImpl: ff.fetch }, cbs);
		await waitForEnd(cbs);
		// Assert
		assert.deepStrictEqual(cbs.content, ['ok']);
		assert.strictEqual(ff.calls.length, 2);
	});

	it('retries on network error then succeeds', async () => {
		// Arrange
		const ff = new FakeFetch();
		ff.enqueue(
			new Error('ECONNRESET'),
			sseResponse(200, ['data: {"type":"content","data":"ok"}\n\n'])
		);
		const cbs = makeCallbacks();
		// Act
		streamToolResult(RESULTS, 's1', { ...BASE, fetchImpl: ff.fetch }, cbs);
		await waitForEnd(cbs);
		// Assert
		assert.strictEqual(ff.calls.length, 2);
	});

	it('reports error after exhausting retries', async () => {
		// Arrange
		const ff = new FakeFetch();
		ff.enqueue(new Error('fail'), new Error('fail'), new Error('fail'));
		const cbs = makeCallbacks();
		// Act
		streamToolResult(RESULTS, 's1', { ...BASE, fetchImpl: ff.fetch, maxRetries: 3 }, cbs);
		await waitForError(cbs);
		// Assert
		assert.strictEqual(cbs.errors.length, 1);
		assert.ok(cbs.errors[0] instanceof ProtocolError);
		assert.strictEqual(ff.calls.length, 3);
	});
});

// 等待流结束（onEnd）的轮询助手
function waitForEnd(cbs: { ended: boolean }): Promise<void> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = () => {
			if (cbs.ended || Date.now() - start > 1000) {
				resolve();
			} else {
				setTimeout(tick, 5);
			}
		};
		tick();
	});
}

function waitForError(cbs: { errors: Error[] }): Promise<void> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = () => {
			if (cbs.errors.length > 0 || Date.now() - start > 1000) {
				resolve();
			} else {
				setTimeout(tick, 5);
			}
		};
		tick();
	});
}
