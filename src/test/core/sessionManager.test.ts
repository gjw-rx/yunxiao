import * as assert from 'assert';
import { SessionManager, type StreamClient } from '../../core/sessionManager';
import { EventBus, type AgentEvent } from '../../core/eventBus';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { BaseTool, type ToolExecutionResult, type ToolContext } from '../../tools/baseTool';
import type { SseCallbacks } from '../../protocol/sseHandler';
import type { ToolCall, ToolResult, ToolSchema } from '../../core/types';

// ── 可配置的假工具 ──
class FakeTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.read_file',
		description: 'fake',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		permissions: 'read',
		site: 'local',
	};
	constructor(private readonly behavior: 'success' | 'error' = 'success') {
		super();
	}
	async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutionResult> {
		if (this.behavior === 'error') {
			throw new Error('boom');
		}
		return { status: 'success', result: `content of ${args.path ?? ''}` };
	}
}

// ── 脚本化假流客户端 ──
type EventScript = (cbs: SseCallbacks) => void;
const emitToolCall = (call: ToolCall): EventScript => (cbs) => cbs.onToolCall?.(call);
const emitContent = (text: string): EventScript => (cbs) => cbs.onContent?.(text);
const endStream = (): EventScript => (cbs) => cbs.onEnd?.();
const seq = (...scripts: EventScript[]): EventScript => (cbs) => scripts.forEach((s) => s(cbs));

class FakeStreamClient implements StreamClient {
	private scripts: EventScript[] = [];
	private idx = 0;
	readonly messageCalls: { sessionId: string; text: string }[] = [];
	readonly submitCalls: { result: ToolResult; sessionId: string }[] = [];
	setScripts(scripts: EventScript[]): void {
		this.scripts = scripts;
		this.idx = 0;
	}
	streamMessage(sessionId: string, text: string, cbs: SseCallbacks): AbortController {
		this.messageCalls.push({ sessionId, text });
		this.runNext(cbs);
		return new AbortController();
	}
	submitToolResult(result: ToolResult, sessionId: string, cbs: SseCallbacks): AbortController {
		this.submitCalls.push({ result, sessionId });
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

function setup(behavior: 'success' | 'error' = 'success') {
	const eventBus = new EventBus();
	const registry = new ToolRegistry();
	registry.register(new FakeTool(behavior));
	const router = new ToolRouter(registry);
	const client = new FakeStreamClient();
	const manager = new SessionManager({
		client,
		router,
		eventBus,
		toolTimeoutMs: 1000,
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
		assert.strictEqual(client.submitCalls[0].result.call_id, 'c1');
		assert.strictEqual(client.submitCalls[0].result.status, 'success');
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
		assert.strictEqual(client.submitCalls[0].result.call_id, 'c1');
		assert.strictEqual(client.submitCalls[1].result.call_id, 'c2');
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
		assert.strictEqual(client.submitCalls[0].result.status, 'error');
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
		assert.strictEqual(client.submitCalls[0].result.status, 'cancelled');
		assert.strictEqual(client.submitCalls[0].result.call_id, 'c1');
	});
});
