import * as assert from 'assert';
import { SessionManager, type StreamClient } from '../../core/sessionManager';
import { EventBus, type AgentEvent } from '../../core/eventBus';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { BaseTool, type ToolExecutionResult, type ToolContext } from '../../tools/baseTool';
import type { SseCallbacks } from '../../protocol/sseHandler';
import type { ToolCall, ToolResult, ToolSchema } from '../../core/types';
import { ProtocolError, TransportError } from '../../core/errors';
import { RunStore, type WorkspaceState } from '../../core/runStore';

// ── 可配置的假工具 ──
class FakeTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.read_file',
		description: 'fake',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		permissions: 'read',
		site: 'local',
	};
	lastAbortSignal?: AbortSignal;

	constructor(private readonly behavior: 'success' | 'error' | 'slow' | 'slow_warn' = 'success') {
		super();
	}
	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
		this.lastAbortSignal = ctx.abortSignal;
		if (this.behavior === 'error') {
			throw new Error('boom');
		}
		if (this.behavior === 'slow' || this.behavior === 'slow_warn') {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (this.behavior === 'slow_warn') {
			ctx.warn?.('stale warning');
		}
		return { status: 'success', result: `content of ${args.path ?? ''}` };
	}
}

// ── 脚本化假流客户端（内部使用 v1 风格 SseCallbacks 驱动，转换为 v2 事件）──
type EventScript = (cbs: SseCallbacks) => void;
const emitToolCall = (call: ToolCall): EventScript => (cbs) => cbs.onToolCall?.(call);
const emitContent = (text: string): EventScript => (cbs) => cbs.onContent?.(text);
const endStream = (): EventScript => (cbs) => cbs.onEnd?.();
const seq = (...scripts: EventScript[]): EventScript => (cbs) => scripts.forEach((s) => s(cbs));

/** v2 subscribeRun 的回调集合，用于测试中模拟旧轮次事件。 */
interface V2Callbacks {
	onEvent: (event: { sequence: number | null; type: string; payload: unknown }) => void;
	onError: (error: Error) => void;
	onEnd: () => void;
}

class FakeStreamClient implements StreamClient {
	private scripts: EventScript[] = [];
	private idx = 0;
	readonly submitCalls: { results: ToolResult[]; sessionId: string }[] = [];
	readonly subscriptions: { runId: string; afterSequence: number }[] = [];
	readonly createRunCalls: { sessionId: string; text: string; clientRequestId: string }[] = [];
	readonly submitRunResultCalls: { runId: string; results: ToolResult[] }[] = [];
	private readonly callbackQueue: V2Callbacks[] = [];
	private nextSequence = 0;

	setScripts(scripts: EventScript[]): void {
		this.scripts = scripts;
		this.idx = 0;
	}

	createRun(sessionId: string, text: string, clientRequestId: string): Promise<{ run_id: string; session_id: string; status: 'pending' }> {
		this.createRunCalls.push({ sessionId, text, clientRequestId });
		return Promise.resolve({ run_id: 'run-1', session_id: sessionId, status: 'pending' });
	}

	submitRunToolResult(runId: string, results: ToolResult[]): Promise<void> {
		this.submitRunResultCalls.push({ runId, results });
		this.submitCalls.push({ results, sessionId: 'run-session' });
		return Promise.resolve();
	}

	subscribeRun(
		runId: string,
		afterSequence: number,
		onEvent: (event: { sequence: number | null; type: string; payload: unknown }) => void,
		onError: (error: Error) => void,
		onEnd: () => void,
	): AbortController {
		this.subscriptions.push({ runId, afterSequence });
		let interrupted = false;
		const callbacks: SseCallbacks = {
			onContent: (content) => onEvent(this.nextRunEvent('content', { type: 'content', data: content })),
			onToolCall: (call) => {
				interrupted = true;
				onEvent(this.nextRunEvent('tool_call', { type: 'tool_call', data: [call] }));
			},
			onError,
			onEnd: () => {
				onEvent(this.nextRunEvent('run_status', {
					type: 'run_status',
					data: { status: interrupted ? 'interrupted' : 'completed' },
				}));
				onEnd();
			},
		};
		this.callbackQueue.push({ onEvent, onError, onEnd });
		this.runNext(callbacks);
		return new AbortController();
	}

	/** 直接向最近一次订阅推送事件（用于测试中模拟额外事件）。 */
	emitRunEvent(event: { sequence: number | null; type: string; payload: unknown }): void {
		this.callbackQueue.at(-1)?.onEvent(event);
	}

	/** 取得某次订阅的回调集合（用于测试旧轮次事件被忽略）。 */
	getV2Callbacks(index: number): V2Callbacks | undefined {
		return this.callbackQueue[index];
	}

	private nextRunEvent(type: string, payload: unknown): { sequence: number | null; type: string; payload: unknown } {
		// v2.1: content 事件 sequence 为 null（瞬态，不落库）；其他事件为单调递增整数
		if (type === 'content') {
			return { sequence: null, type, payload };
		}
		this.nextSequence += 1;
		return { sequence: this.nextSequence, type, payload };
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

function setup(
	behavior: 'success' | 'error' | 'slow' | 'slow_warn' = 'success',
	toolTimeoutMs = 1000,
	runStore?: RunStore,
) {
	const eventBus = new EventBus();
	const registry = new ToolRegistry();
	const tool = new FakeTool(behavior);
	registry.register(tool);
	const router = new ToolRouter(registry);
	const client = new FakeStreamClient();
	const manager = new SessionManager({
		client,
		router,
		eventBus,
		toolTimeoutMs,
		getWorkspaceRoots: () => [],
		getMaxFileSize: () => undefined,
		runStore,
	});
	const events: AgentEvent[] = [];
	eventBus.onAll((e) => events.push(e));
	return { eventBus, client, manager, events, tool };
}

class MemoryWorkspaceState implements WorkspaceState {
	private readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
	async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

class DelayedWorkspaceState implements WorkspaceState {
	private readonly values = new Map<string, unknown>();
	private blocked = false;
	private releaseBlockedUpdate?: () => void;
	private blockedUpdate?: Promise<void>;

	get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
		if (this.blockedUpdate) {
			await this.blockedUpdate;
		}
	}

	blockUpdates(): void {
		if (this.blocked) {
			return;
		}
		this.blocked = true;
		this.blockedUpdate = new Promise((resolve) => {
			this.releaseBlockedUpdate = resolve;
		});
	}

	releaseUpdates(): void {
		this.releaseBlockedUpdate?.();
		this.releaseBlockedUpdate = undefined;
		this.blockedUpdate = undefined;
		this.blocked = false;
	}
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
	it('uses the Run API for a new message and renders persisted content', async () => {
		const { client, manager, events } = setup();
		client.setScripts([() => undefined]);

		manager.sendMessage('s1', 'hello');
		await flushMicrotasks();
		client.emitRunEvent({ sequence: null, type: 'content', payload: { type: 'content', data: 'hello' } });
		await flushMicrotasks();

		assert.strictEqual(client.createRunCalls.length, 1);
		assert.ok(events.some((event) => event.type === 'content' && event.payload === 'hello'));
	});

	it('renders content defensively when the server sends sequence zero', async () => {
		const { client, manager, events } = setup();
		client.setScripts([() => undefined]);
		manager.sendMessage('s1', 'hello');
		await flushMicrotasks();

		const callbacks = client.getV2Callbacks(0)!;
		callbacks.onEvent({
			sequence: 1,
			type: 'run_status',
			payload: { type: 'run_status', data: { status: 'running' } },
		});
		callbacks.onEvent({
			sequence: 0,
			type: 'content',
			payload: { type: 'content', data: '兼容回复' },
		});
		await flushMicrotasks();

		assert.ok(events.some((event) => event.type === 'content' && event.payload === '兼容回复'));
	});

	it('correlates tool lifecycle events with their tool call id', async () => {
		const { client, manager, events } = setup();
		client.setScripts([() => undefined]);
		manager.sendMessage('s1', 'read a.ts');
		await flushMicrotasks();

		client.emitRunEvent({
			sequence: 1,
			type: 'tool_start',
			payload: {
				type: 'tool_start',
				data: {
					run_id: 'tool-run-1',
					tool_call_id: 'call-1',
					name: 'fs.read_file',
					input: { path: 'a.ts' },
				},
			},
		});
		client.emitRunEvent({
			sequence: 2,
			type: 'tool_end',
			payload: {
				type: 'tool_end',
				data: {
					run_id: 'tool-run-1',
					name: 'fs.read_file',
					output: 'content',
				},
			},
		});
		await flushMicrotasks();

		const toolEvents = events
			.filter((event) => event.type === 'tool_state_change')
			.map((event) => event.payload as { call_id: string });
		assert.deepStrictEqual(toolEvents.map((event) => event.call_id), ['call-1', 'call-1']);
	});

	it('completes a pure-chat turn with no tool calls', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([seq(emitContent('hi'), endStream())]);
		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);
		assert.ok(events.some((e) => e.type === 'content' && e.payload === 'hi'));
		assert.strictEqual(client.submitCalls.length, 0);
	});

	it('accepts archived content after completed until the SSE stream ends', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([() => undefined]);
		manager.sendMessage('s1', 'hello');
		await flushMicrotasks();

		const callbacks = client.getV2Callbacks(0)!;
		callbacks.onEvent({
			sequence: 1,
			type: 'run_status',
			payload: { type: 'run_status', data: { status: 'completed' } },
		});
		callbacks.onEvent({
			sequence: null,
			type: 'content',
			payload: { type: 'content', data: '完整回复' },
		});
		await flushMicrotasks();

		assert.ok(events.some((event) => event.type === 'content' && event.payload === '完整回复'));
		assert.ok(!events.some((event) => event.type === 'stream_end'));

		const endPromise = waitForStreamEnd(eventBus);
		callbacks.onEnd();
		await endPromise;
		assert.deepStrictEqual(terminalStates(events), ['completed']);
	});

	it('runs a single tool_call round: execute -> submit -> continuation content', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			seq(emitContent('summary'), endStream()),
		]);
		manager.sendMessage('s1', 'read a.ts');
		await waitForStreamEnd(eventBus);
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

	it('waits for persisted tool_call events before handling SSE end', async () => {
		const workspaceState = new DelayedWorkspaceState();
		const runStore = new RunStore(workspaceState);
		const { eventBus, client, manager, events } = setup('success', 1000, runStore);
		client.setScripts([
			() => undefined,
			seq(emitContent('summary'), endStream()),
		]);
		manager.sendMessage('s1', 'read a.ts');
		await flushMicrotasks();

		workspaceState.blockUpdates();
		const callbacks = client.getV2Callbacks(0)!;
		const endPromise = waitForStreamEnd(eventBus);
		callbacks.onEvent({
			sequence: 1,
			type: 'tool_call',
			payload: { type: 'tool_call', data: [call('c1')] },
		});
		callbacks.onEvent({
			sequence: 2,
			type: 'run_status',
			payload: { type: 'run_status', data: { status: 'interrupted' } },
		});
		callbacks.onEnd();
		workspaceState.releaseUpdates();

		await endPromise;
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results[0].call_id, 'c1');
		assert.ok(events.some((event) => event.type === 'content' && event.payload === 'summary'));
	});

	it('runs multiple sequential tool_call rounds', async () => {
		const { eventBus, client, manager } = setup();
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			seq(emitToolCall(call('c2')), endStream()),
			seq(emitContent('done'), endStream()),
		]);
		manager.sendMessage('s1', 'read two files');
		await waitForStreamEnd(eventBus);
		assert.strictEqual(client.submitCalls.length, 2);
		assert.strictEqual(client.submitCalls[0].results[0].call_id, 'c1');
		assert.strictEqual(client.submitCalls[1].results[0].call_id, 'c2');
	});

	it('runs a batch tool_call round: parallel execute -> batch submit', async () => {
		const { eventBus, client, manager } = setup();
		client.setScripts([
			seq(emitToolCall(call('c1')), emitToolCall(call('c2')), endStream()),
			seq(emitContent('done'), endStream()),
		]);
		manager.sendMessage('s1', 'read two files at once');
		await waitForStreamEnd(eventBus);
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results.length, 2);
		const callIds = client.submitCalls[0].results.map((r) => r.call_id).sort();
		assert.deepStrictEqual(callIds, ['c1', 'c2']);
		const statuses = client.submitCalls[0].results.map((r) => r.status);
		assert.deepStrictEqual(statuses, ['success', 'success']);
	});

	it('posts an error result when the tool throws, then continues', async () => {
		const { eventBus, client, manager, events } = setup('error');
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			seq(emitContent('recovered'), endStream()),
		]);
		manager.sendMessage('s1', 'read a.ts');
		await waitForStreamEnd(eventBus);
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results[0].status, 'error');
		assert.ok(events.some((e) => e.type === 'content' && e.payload === 'recovered'));
	});

	it('cancels a pending tool_call: posts cancelled result and ends stream', async () => {
		const { eventBus, client, manager } = setup();
		client.setScripts([emitToolCall(call('c1'))]);
		manager.sendMessage('s1', 'read a.ts');
		await waitForToolState(eventBus, 'pending');
		const endPromise = waitForStreamEnd(eventBus);
		manager.cancel('s1');
		await endPromise;
		assert.strictEqual(client.submitCalls.length, 1);
		assert.strictEqual(client.submitCalls[0].results[0].status, 'cancelled');
		assert.strictEqual(client.submitCalls[0].results[0].call_id, 'c1');
	});

	it('cancels multiple pending tool_calls: posts batch cancelled results', async () => {
		const { eventBus, client, manager } = setup();
		client.setScripts([seq(emitToolCall(call('c1')), emitToolCall(call('c2')))]);
		manager.sendMessage('s1', 'read two files');
		await waitForToolState(eventBus, 'pending');
		const endPromise = waitForStreamEnd(eventBus);
		manager.cancel('s1');
		await endPromise;
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
		const staleCbs = client.getV2Callbacks(0)!;

		manager.sendMessage('s1', 'new');
		await waitForStreamEnd(eventBus);

		// 模拟旧轮次的事件回调（content 为瞬态事件，sequence 为 null）
		staleCbs.onEvent({ sequence: null, type: 'content', payload: { type: 'content', data: 'stale' } });
		staleCbs.onEvent({ sequence: 100, type: 'tool_call', payload: { type: 'tool_call', data: [call('stale-call')] } });
		staleCbs.onEnd();
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
		const staleCbs = client.getV2Callbacks(0)!;

		manager.reset('s1');
		client.setScripts([seq(emitContent('current'), endStream())]);
		manager.sendMessage('s1', 'new');
		await waitForStreamEnd(eventBus);

		staleCbs.onEvent({ sequence: null, type: 'content', payload: { type: 'content', data: 'stale' } });
		staleCbs.onEnd();
		await flushMicrotasks();

		assert.ok(!events.some((event) => event.type === 'content' && event.payload === 'stale'));
		assert.deepStrictEqual(terminalStates(events), ['completed']);
	});

	it('aborts active tools when the session is reset', async () => {
		const { client, manager, eventBus, tool } = setup('slow');
		client.setScripts([seq(emitToolCall(call('c1')), endStream())]);
		manager.sendMessage('s1', 'old');
		await waitForToolState(eventBus, 'running');

		manager.reset('s1');

		assert.strictEqual(tool.lastAbortSignal?.aborted, true);
	});

	it('ignores warnings emitted by a replaced tool run', async () => {
		const { client, manager, eventBus, events } = setup('slow_warn');
		client.setScripts([
			seq(emitToolCall(call('c1')), endStream()),
			seq(emitContent('current'), endStream()),
		]);
		manager.sendMessage('s1', 'old');
		await waitForToolState(eventBus, 'running');
		manager.sendMessage('s1', 'new');
		await waitForStreamEnd(eventBus);
		await new Promise((resolve) => setTimeout(resolve, 75));

		assert.strictEqual(events.some((event) => event.payload === 'stale warning'), false);
	});

	it('emits completed once for a clean run and keeps legacy stream_end', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([endStream()]);
		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);

		assert.deepStrictEqual(terminalStates(events), ['completed']);
		assert.strictEqual(events.filter((event) => event.type === 'stream_end').length, 1);
	});

	it('completes when a legacy run store has no updateStatus method', async () => {
		const runStore = new RunStore(new MemoryWorkspaceState());
		(runStore as unknown as { updateStatus?: RunStore['updateStatus'] }).updateStatus = undefined;
		const { eventBus, client, manager, events } = setup('success', 1000, runStore);
		client.setScripts([endStream()]);

		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);

		assert.deepStrictEqual(terminalStates(events), ['completed']);
		assert.strictEqual(events.some((event) => event.type === 'error'), false);
	});

	it('completes when persisting the run status fails', async () => {
		const runStore = new RunStore(new MemoryWorkspaceState());
		runStore.updateStatus = async () => {
			throw new Error('workspace state unavailable');
		};
		const { eventBus, client, manager, events } = setup('success', 1000, runStore);
		client.setScripts([endStream()]);

		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);

		assert.deepStrictEqual(terminalStates(events), ['completed']);
		assert.strictEqual(events.some((event) => event.type === 'error'), false);
	});

	it('emits cancelled once and ignores a later end callback', async () => {
		const { eventBus, client, manager, events } = setup();
		client.setScripts([() => undefined]);
		manager.sendMessage('s1', 'hello');
		await flushMicrotasks();
		const staleCbs = client.getV2Callbacks(0)!;
		const endPromise = waitForStreamEnd(eventBus);
		manager.cancel('s1');
		await endPromise;
		staleCbs.onEnd();
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
		client.setScripts([(callbacks) => callbacks.onError?.(new TransportError('socket closed'))]);
		manager.sendMessage('s1', 'hello');
		await waitForStreamEnd(eventBus);

		assert.deepStrictEqual(terminalStates(events), ['disconnected']);
	});

	it('replays stored timeline events without deriving a lifecycle state', async () => {
		const { eventBus, client, events } = setup();
		const store = new RunStore(new MemoryWorkspaceState());
		await store.save({
			sessionId: 's1', runId: 'r1', cursor: 2, status: 'running', workspaceRoots: [],
			events: [
				{ sequence: 1, type: 'content_batch', payload: { content: 'saved' } },
				{ sequence: 2, type: 'budget_update', payload: { usage: { tokens: 2 }, limits: { tokens: 10 } } },
			],
			timeline: [],
		});
		const restored = store.get('s1');
		assert.ok(restored);
		const restoredManager = new SessionManager({
			client, router: new ToolRouter(new ToolRegistry()), eventBus, getWorkspaceRoots: () => [], runStore: store,
		});
		restoredManager.restoreRun(restored!);
		assert.ok(events.some((event) => event.type === 'content_batch'));
		assert.ok(events.some((event) => event.type === 'budget_update'));
		assert.strictEqual(events.some((event) => event.type === 'run_state_change'), false);
		assert.deepStrictEqual(client.subscriptions, [{ runId: 'r1', afterSequence: 2 }]);
	});
});
