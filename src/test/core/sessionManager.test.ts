import * as assert from 'assert';
import { SessionManager, type StreamClient } from '../../core/sessionManager';
import { EventBus, type AgentEvent } from '../../core/eventBus';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { BaseTool, type ToolExecutionResult, type ToolContext } from '../../tools/baseTool';
import type { SseCallbacks } from '../../protocol/sseHandler';
import type { ToolCall, ToolResult, ToolSchema } from '../../core/types';
import { ProtocolError } from '../../core/errors';

// ── 可配置的假工具 ──
class FakeTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.read_file',
		description: 'fake',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		permissions: 'read',
		site: 'local',
	};
	constructor(private readonly behavior: 'success' | 'error' | 'slow' = 'success') {
		super();
	}
	async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutionResult> {
		if (this.behavior === 'error') {
			throw new Error('boom');
		}
		if (this.behavior === 'slow') {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return { status: 'success', result: `content of ${args.path ?? ''}` };
	}
}

// ── 脚本化假流客户端 ──
type EventScript = (cbs: SseCallbacks) => void;
const emitToolCall = (call: ToolCall): EventScript => (cbs) => cbs.onToolCall?.(call);
const emitContent = (text: string): EventScript => (cbs) => cbs.onContent?.(text);
const endStream = (): EventScript => (cbs) => cbs.onEnd?.();
const acknowledgeDuplicate = (): EventScript => (cbs) => {
	const callbacks = cbs as SseCallbacks & { onDuplicateAcknowledged?: () => void };
	callbacks.onDuplicateAcknowledged?.();
};
const seq = (...scripts: EventScript[]): EventScript => (cbs) => scripts.forEach((s) => s(cbs));

class FakeStreamClient implements StreamClient {
	private scripts: EventScript[] = [];
	private idx = 0;
	readonly messageCalls: { sessionId: string; text: string }[] = [];
	readonly submitCalls: { results: ToolResult[]; sessionId: string }[] = [];
	readonly messageCallbacks: SseCallbacks[] = [];
	readonly submitCallbacks: SseCallbacks[] = [];
	setScripts(scripts: EventScript[]): void {
		this.scripts = scripts;
		this.idx = 0;
	}
	streamMessage(sessionId: string, text: string, cbs: SseCallbacks): AbortController {
		this.messageCalls.push({ sessionId, text });
		this.messageCallbacks.push(cbs);
		this.runNext(cbs);
		return new AbortController();
	}
	submitToolResult(results: ToolResult[], sessionId: string, cbs: SseCallbacks): AbortController {
		this.submitCalls.push({ results, sessionId });
		this.submitCallbacks.push(cbs);
		this.runNext(cbs);
		return new AbortController();
	}
	private runNext(cbs: SseCallbacks): void {
		const script = this.scripts[this.idx++];
		queueMicrotask(() => {
			if (script) {
				script(cbs);
			} else {
				cbs.onEnd?.();
			}
		});
	}
}

function setup(behavior: 'success' | 'error' | 'slow' = 'success', toolTimeoutMs = 1000) {
	const eventBus = new EventBus();
	const registry = new ToolRegistry();
	registry.register(new FakeTool(behavior));
	const router = new ToolRouter(registry);
	const client = new FakeStreamClient();
	const manager = new SessionManager({
		client,
		router,
		eventBus,
		toolTimeoutMs,
		getWorkspaceRoots: () => [],
		getMaxFileSize: () => undefined,
	});
	const events: AgentEvent[] = [];
	eventBus.onAll((e) => events.push(e));
	return { eventBus, client, manager, events };
}

function waitForStreamEnd(eventBus: EventBus, timeoutMs = 1000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout waiting for stream_end')), timeoutMs);
		const unsub = eventBus.on('stream_end', () => {
			clearTimeout(timer);
			unsub();
			resolve();
		});
	});
}

function waitForToolState(
	eventBus: EventBus,
	state: string,
	timeoutMs = 1000
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for tool state ${state}`)), timeoutMs);
		const unsub = eventBus.on('tool_state_change', (e) => {
			const payload = e.payload as { state: string };
			if (payload.state === state) {
				clearTimeout(timer);
				unsub();
				resolve();
			}
		});
	});
}

function terminalStates(events: AgentEvent[]): string[] {
	return events
		.filter((event) => event.type === ('run_state_change' as AgentEvent['type']))
		.map((event) => (event.payload as { state: string }).state)
		.filter((state) => ['completed', 'cancelled', 'failed', 'disconnected'].includes(state));
}

async function flushMicrotasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const call = (id: string): ToolCall => ({
	call_id: id,
	tool: 'fs.read_file',
	args: { path: 'a.ts' },
	site: 'local',
});

describe('SessionManager', () => {
	it('completes a pure-chat turn with no tool calls', async () => {
		// Arrange
		const { eventBus, client, manager, events } = setup();
		client.setScripts([seq(emitContent('hi'), endStream())]);
		// Act
		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);
		// Assert
		assert.ok(events.some((e) => e.type === 'content' && e.payload === 'hi'));
		assert.strictEqual(client.submitCalls.length, 0);
	});

	it('runs a single tool_call round: execute -> submit -> continuation content', async () => {
		// Arrange
		const { eventBus, client, manager, events } = setup();
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			seq(emitContent('summary'), endStream()),
		]);
		// Act
		manager.sendMessage('s1', 'read a.ts');
		await waitForStreamEnd(eventBus);
		// Assert
		const states = events
			.filter((e) => e.type === 'tool_state_change')
			.map((e) => (e.payload as { state: string }).state);
		assert.deepStrictEqual(states, ['pending', 'running', 'success']);
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results[0].call_id, 'c1');
		assert.strictEqual(client.submitCalls[0].results[0].status, 'success');
		assert.ok(events.some((e) => e.type === 'content' && e.payload === 'summary'));
		assert.ok(events.some((e) => e.type === 'tool_result'));
	});

	it('runs multiple sequential tool_call rounds', async () => {
		// Arrange
		const { eventBus, client, manager } = setup();
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			seq(emitToolCall(call('c2')), endStream()),
			seq(emitContent('done'), endStream()),
		]);
		// Act
		manager.sendMessage('s1', 'read two files');
		await waitForStreamEnd(eventBus);
		// Assert
		assert.strictEqual(client.submitCalls.length, 2);
		assert.strictEqual(client.submitCalls[0].results[0].call_id, 'c1');
		assert.strictEqual(client.submitCalls[1].results[0].call_id, 'c2');
	});

	it('runs a batch tool_call round: parallel execute -> batch submit', async () => {
		// Arrange
		const { eventBus, client, manager } = setup();
		client.setScripts([
			seq(emitToolCall(call('c1')), emitToolCall(call('c2')), endStream()),
			seq(emitContent('done'), endStream()),
		]);
		// Act
		manager.sendMessage('s1', 'read two files at once');
		await waitForStreamEnd(eventBus);
		// Assert
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results.length, 2);
		const callIds = client.submitCalls[0].results.map((r) => r.call_id).sort();
		assert.deepStrictEqual(callIds, ['c1', 'c2']);
		const statuses = client.submitCalls[0].results.map((r) => r.status);
		assert.deepStrictEqual(statuses, ['success', 'success']);
	});

	it('posts an error result when the tool throws, then continues', async () => {
		// Arrange
		const { eventBus, client, manager, events } = setup('error');
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			seq(emitContent('recovered'), endStream()),
		]);
		// Act
		manager.sendMessage('s1', 'read a.ts');
		await waitForStreamEnd(eventBus);
		// Assert
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results[0].status, 'error');
		assert.ok(events.some((e) => e.type === 'content' && e.payload === 'recovered'));
	});

	it('cancels a pending tool_call: posts cancelled result and ends stream', async () => {
		// Arrange
		const { eventBus, client, manager } = setup();
		client.setScripts([emitToolCall(call('c1'))]); // 无 end：流保持开启
		// Act
		manager.sendMessage('s1', 'read a.ts');
		await waitForToolState(eventBus, 'pending');
		const endPromise = waitForStreamEnd(eventBus);
		manager.cancel('s1');
		await endPromise;
		// Assert
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results[0].status, 'cancelled');
		assert.strictEqual(client.submitCalls[0].results[0].call_id, 'c1');
	});

	it('cancels multiple pending tool_calls: posts batch cancelled results', async () => {
		// Arrange
		const { eventBus, client, manager } = setup();
		client.setScripts([seq(emitToolCall(call('c1')), emitToolCall(call('c2')))]); // 无 end
		// Act
		manager.sendMessage('s1', 'read two files');
		await waitForToolState(eventBus, 'pending');
		const endPromise = waitForStreamEnd(eventBus);
		manager.cancel('s1');
		await endPromise;
		// Assert
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results.length, 2);
		const statuses = client.submitCalls[0].results.map((r) => r.status);
		assert.deepStrictEqual(statuses, ['cancelled', 'cancelled']);
	});

	it('times out a running tool, posts one error result, and continues', async () => {
		const { eventBus, client, manager } = setup('slow', 5);
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			seq(emitContent('recovered'), endStream()),
		]);
		manager.sendMessage('s1', 'read a.ts');
		await waitForStreamEnd(eventBus);
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results[0].status, 'error');
		assert.ok(client.submitCalls[0].results[0].error?.includes('超时'));
	});

	it('cancelling a running tool posts only one cancelled result despite late completion', async () => {
		const { eventBus, client, manager } = setup('slow');
		client.setScripts([seq(emitToolCall(call('c1')), endStream())]);
		manager.sendMessage('s1', 'read a.ts');
		await waitForToolState(eventBus, 'running');
		const endPromise = waitForStreamEnd(eventBus);
		manager.cancel('s1');
		await endPromise;
		await new Promise((resolve) => setTimeout(resolve, 75));
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results[0].status, 'cancelled');
	});

	it('ignores content, tool calls, and end callbacks from a replaced run', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([
			() => undefined,
			seq(emitContent('current'), endStream()),
		]);
		manager.sendMessage('s1', 'old');
		await flushMicrotasks();
		const staleCallbacks = client.messageCallbacks[0];

		manager.sendMessage('s1', 'new');
		await waitForStreamEnd(eventBus);
		staleCallbacks.onContent?.('stale');
		staleCallbacks.onToolCall?.(call('stale-call'));
		staleCallbacks.onEnd?.();
		await flushMicrotasks();

		assert.ok(events.some((event) => event.type === 'content' && event.payload === 'current'));
		assert.ok(!events.some((event) => event.type === 'content' && event.payload === 'stale'));
		assert.ok(!events.some((event) =>
			event.type === 'tool_state_change'
			&& (event.payload as { call_id?: string }).call_id === 'stale-call'
		));
		assert.strictEqual(client.submitCalls.length, 0);
		assert.deepStrictEqual(terminalStates(events), ['completed']);
	});

	it('ignores callbacks from a reset state after the session id is reused', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([() => undefined]);
		manager.sendMessage('s1', 'old');
		await flushMicrotasks();
		const staleCallbacks = client.messageCallbacks[0];

		manager.reset('s1');
		client.setScripts([seq(emitContent('current'), endStream())]);
		manager.sendMessage('s1', 'new');
		await waitForStreamEnd(eventBus);
		staleCallbacks.onContent?.('stale');
		staleCallbacks.onEnd?.();
		await flushMicrotasks();

		assert.ok(!events.some((event) => event.type === 'content' && event.payload === 'stale'));
		assert.deepStrictEqual(terminalStates(events), ['completed']);
	});

	it('emits completed once for a clean run and keeps legacy stream_end', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([endStream()]);
		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);

		assert.deepStrictEqual(terminalStates(events), ['completed']);
		assert.strictEqual(events.filter((event) => event.type === 'stream_end').length, 1);
	});

	it('emits cancelled once and ignores a later end callback', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([() => undefined]);
		manager.sendMessage('s1', 'hello');
		await flushMicrotasks();
		const callbacks = client.messageCallbacks[0];
		const endPromise = waitForStreamEnd(eventBus);
		manager.cancel('s1');
		await endPromise;
		callbacks.onEnd?.();
		await flushMicrotasks();

		assert.deepStrictEqual(terminalStates(events), ['cancelled']);
	});

	it('emits failed once for a protocol error', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([(callbacks) => callbacks.onError?.(new ProtocolError('bad response', 400))]);
		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);

		assert.deepStrictEqual(terminalStates(events), ['failed']);
	});

	it('emits disconnected once for an unexpected transport error', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([(callbacks) => callbacks.onError?.(new TypeError('fetch failed'))]);
		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);

		assert.deepStrictEqual(terminalStates(events), ['disconnected']);
	});

	it('marks a duplicate tool-result acknowledgement disconnected without re-executing', async () => {
		const { client, manager, events } = setup();
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			acknowledgeDuplicate(),
		]);

		manager.sendMessage('s1', 'read a.ts');
		await new Promise((resolve) => setTimeout(resolve, 25));

		assert.strictEqual(client.submitCalls.length, 1);
		assert.deepStrictEqual(terminalStates(events), ['disconnected']);
		assert.strictEqual(
			events.filter((event) =>
				event.type === 'tool_state_change'
				&& (event.payload as { call_id?: string; state?: string }).call_id === 'c1'
				&& (event.payload as { state?: string }).state === 'running'
			).length,
			1
		);
	});
});
