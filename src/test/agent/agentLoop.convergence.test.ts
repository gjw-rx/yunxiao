import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { MessageStore } from '../../memory/messageStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import type { LLMProvider, LLMEvent } from '../../llm/types';
import type { ToolSchema, ToolCallStatus } from '../../core/types';
import type { ToolContext } from '../../tools/baseTool';
import { BaseTool } from '../../tools/baseTool';
import type { AgentEvent } from '../../core/eventBus';

// ── Mock 工具 ──

class MockReadTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'read_file',
		description: 'Read a file',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		permissions: 'read',
		canParallel: true,
	};

	private callCount = 0;

	async execute(args: Record<string, unknown>): Promise<{ status: ToolCallStatus; result?: string; error?: string }> {
		this.callCount++;
		return { status: 'success', result: `content of ${args.path} (call #${this.callCount})` };
	}

	getCallCount(): number {
		return this.callCount;
	}
}

class MockWriteTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'write_file',
		description: 'Write a file',
		parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
		permissions: 'write',
	};

	private callCount = 0;

	async execute(args: Record<string, unknown>): Promise<{ status: ToolCallStatus; result?: string; error?: string }> {
		this.callCount++;
		return { status: 'success', result: `wrote ${args.path} (call #${this.callCount})` };
	}

	getCallCount(): number {
		return this.callCount;
	}
}

/** 可观测并发的只读工具：记录最大并发数与执行顺序。 */
class MockProbeReadTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'read_file',
		description: 'Read a file',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		permissions: 'read',
		canParallel: true,
	};

	private active = 0;
	private maxActive = 0;
	private readonly order: string[] = [];
	private readonly delays: Record<string, number>;

	constructor(delays?: Record<string, number>) {
		super();
		this.delays = delays ?? {};
	}

	async execute(args: Record<string, unknown>): Promise<{ status: ToolCallStatus; result?: string; error?: string }> {
		const path = String(args.path);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		await new Promise((resolve) => setTimeout(resolve, this.delays[path] ?? 10));
		this.order.push(path);
		this.active--;
		return { status: 'success', result: `content of ${path}` };
	}

	getMaxActive(): number {
		return this.maxActive;
	}

	getOrder(): string[] {
		return this.order;
	}
}

/** 可观测并发的写工具：写工具必须串行（maxActive 恒为 1）。 */
class MockProbeWriteTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'write_file',
		description: 'Write a file',
		parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
		permissions: 'write',
	};

	private active = 0;
	private maxActive = 0;
	private readonly order: string[] = [];

	async execute(args: Record<string, unknown>): Promise<{ status: ToolCallStatus; result?: string; error?: string }> {
		const path = String(args.path);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		await new Promise((resolve) => setTimeout(resolve, 10));
		this.order.push(path);
		this.active--;
		return { status: 'success', result: `wrote ${path}` };
	}

	getMaxActive(): number {
		return this.maxActive;
	}

	getOrder(): string[] {
		return this.order;
	}
}

// ── Mock LLM Provider ──

function makeToolCallEvent(id: string, name: string, args: Record<string, unknown>): LLMEvent {
	return { type: 'toolCall', id, name, arguments: JSON.stringify(args) };
}

function makeTextEvent(text: string): LLMEvent {
	return { type: 'textDelta', text };
}

function makeFinishEvent(reason: 'stop' | 'tool_use' | 'length' = 'stop'): LLMEvent {
	return { type: 'finish', reason };
}

function makeProvider(eventsPerCall: LLMEvent[][]): LLMProvider {
	let callIndex = 0;
	return {
		async *chatCompletion(): AsyncGenerator<LLMEvent> {
			const events = eventsPerCall[Math.min(callIndex, eventsPerCall.length - 1)];
			callIndex++;
			for (const e of events) {
				yield e;
			}
		},
	};
}

// ── 辅助工厂 ──

function makeAgentLoop(
	provider: LLMProvider,
	registry: ToolRegistry,
	configOverrides?: Record<string, unknown>,
): { loop: AgentLoop; store: MessageStore; events: unknown[] } {
	const store = new MessageStore();
	const events: unknown[] = [];
	const eventBus = new EventBus();
	const originalEmit = eventBus.emit.bind(eventBus);
	eventBus.emit = (e: AgentEvent) => {
		events.push(e);
		return originalEmit(e);
	};

	const router = new ToolRouter(registry);

	const loop = new AgentLoop(provider, store, router, registry, eventBus, {
		model: 'test-model',
		temperature: 0,
		maxTokens: 4096,
		maxSteps: 25,
		workspaceRoots: ['/test'],
		...configOverrides,
	} as never);

	return { loop, store, events };
}

// ── 浒─

describe('AgentLoop convergence', () => {
	describe('Doom loop 检测', () => {
		it('连续3次相同调用触发 doom loop 引导', async () => {
			const readTool = new MockReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			// 3 次相同调用 → 第 3 次触发 doom loop 引导
			// 第 4 次无工具调用 → 结束
			const provider = makeProvider([
				[makeToolCallEvent('1', 'read_file', { path: '/a.ts' }), makeFinishEvent('tool_use')],
				[makeToolCallEvent('2', 'read_file', { path: '/a.ts' }), makeFinishEvent('tool_use')],
				[makeToolCallEvent('3', 'read_file', { path: '/a.ts' }), makeFinishEvent('tool_use')], // doom!
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read /a.ts');

			const history = store.loadHistory('s1');
			const guidanceMsg = history.find(
				(m) => m.role === 'user' && m.content.includes('repeatedly calling'),
			);
			assert.ok(guidanceMsg, '应注入 doom loop 引导消息');
			// read_file 执行了 2 次（第 3 次被 doom loop 拦截）
			assert.strictEqual(readTool.getCallCount(), 2);
		});

		it('不同参数不触发 doom loop', async () => {
			const readTool = new MockReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			const provider = makeProvider([
				[makeToolCallEvent('1', 'read_file', { path: '/a.ts' }), makeFinishEvent('tool_use')],
				[makeToolCallEvent('2', 'read_file', { path: '/b.ts' }), makeFinishEvent('tool_use')],
				[makeToolCallEvent('3', 'read_file', { path: '/c.ts' }), makeFinishEvent('tool_use')],
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read files');

			const history = store.loadHistory('s1');
			const guidanceMsg = history.find(
				(m) => m.role === 'user' && m.content.includes('repeatedly calling'),
			);
			assert.ok(!guidanceMsg, '不应触发 doom loop');
			assert.strictEqual(readTool.getCallCount(), 3);
		});
	});

	describe('无工具缓存', () => {
		it('相同参数的工具始终执行（无缓存）', async () => {
			const readTool = new MockReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			// 2 次相同调用 → 都应执行（无缓存）
			const provider = makeProvider([
				[makeToolCallEvent('1', 'read_file', { path: '/a.ts' }), makeFinishEvent('tool_use')],
				[makeToolCallEvent('2', 'read_file', { path: '/a.ts' }), makeFinishEvent('tool_use')],
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read /a.ts');

			// read_file 执行了 2 次（无缓存）
			assert.strictEqual(readTool.getCallCount(), 2);
			// 不应存在 [cached] 前缀的 tool 消息
			const history = store.loadHistory('s1');
			const cachedToolMsg = history.find(
				(m) => m.role === 'tool' && m.content.includes('[cached]'),
			);
			assert.ok(!cachedToolMsg, '不应存在 [cached] 前缀的 tool 消息');
		});
	});

	describe('步数预警', () => {
		it('达到 80% maxSteps 时注入预警', async () => {
			const readTool = new MockReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			// maxSteps=5, 80% = 4
			const events: LLMEvent[][] = [];
			for (let i = 0; i < 5; i++) {
				events.push([
					makeToolCallEvent(`${i}`, 'read_file', { path: `/file${i}.ts` }),
					makeFinishEvent('tool_use'),
				]);
			}
			events.push([makeTextEvent('Done'), makeFinishEvent()]);

			const provider = makeProvider(events);
			const { loop, store } = makeAgentLoop(provider, registry, { maxSteps: 5 });
			await loop.run('s1', 'read files');

			const history = store.loadHistory('s1');
			const warningMsg = history.find(
				(m) => m.role === 'user' && m.content.includes('approaching the maximum step limit'),
			);
			assert.ok(warningMsg, '应注入步数预警消息');
		});
	});

	describe('工具并行执行', () => {
		it('只读+canParallel 工具最多 3 个并发', async () => {
			const readTool = new MockProbeReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			// 同一轮返回 5 个 read_file 调用 → 应分组并发且峰值并发 ≤ 3
			const provider = makeProvider([
				[
					...Array.from({ length: 5 }, (_, i) => makeToolCallEvent(`r${i}`, 'read_file', { path: `/f${i}.ts` })),
					makeFinishEvent('tool_use'),
				],
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read all');

			const maxActive = readTool.getMaxActive();
			assert.ok(maxActive >= 2, `5 个只读调用应产生并行（实际峰值并发=${maxActive}）`);
			assert.ok(maxActive <= 3, `并发数应不超过 3（实际峰值并发=${maxActive}）`);
			assert.strictEqual(readTool.getOrder().length, 5, '5 个调用全部执行');
		});

		it('结果按模型返回顺序写入消息', async () => {
			// 故意让第一个调用最慢：完成顺序与返回顺序相反
			const readTool = new MockProbeReadTool({ '/f0.ts': 60 });
			const registry = new ToolRegistry();
			registry.register(readTool);

			const provider = makeProvider([
				[
					makeToolCallEvent('r0', 'read_file', { path: '/f0.ts' }),
					makeToolCallEvent('r1', 'read_file', { path: '/f1.ts' }),
					makeToolCallEvent('r2', 'read_file', { path: '/f2.ts' }),
					makeFinishEvent('tool_use'),
				],
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read files');

			// 工具结果消息按调用顺序写入（f0 最慢也排在第一条）
			const toolMsgs = store.loadHistory('s1').filter((m) => m.role === 'tool');
			assert.deepStrictEqual(
				toolMsgs.map((m) => m.content),
				['content of /f0.ts', 'content of /f1.ts', 'content of /f2.ts'],
			);
		});

		it('写工具与写工具之间严格串行，只读组可并行', async () => {
			const readTool = new MockProbeReadTool();
			const writeTool = new MockProbeWriteTool();
			const registry = new ToolRegistry();
			registry.register(readTool);
			registry.register(writeTool);

			// 同一轮：[read, write, read, write]
			const provider = makeProvider([
				[
					makeToolCallEvent('r0', 'read_file', { path: '/a.ts' }),
					makeToolCallEvent('w0', 'write_file', { path: '/a.ts' }),
					makeToolCallEvent('r1', 'read_file', { path: '/b.ts' }),
					makeToolCallEvent('w1', 'write_file', { path: '/b.ts' }),
					makeFinishEvent('tool_use'),
				],
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read then write');

			assert.strictEqual(writeTool.getMaxActive(), 1, '写工具必须串行执行');
			assert.strictEqual(writeTool.getOrder().length, 2, '两个写调用都执行');
			assert.ok(readTool.getMaxActive() >= 2, '两个只读调用应并行');
			// 入库顺序仍与模型返回顺序一致
			const toolMsgs = store.loadHistory('s1').filter((m) => m.role === 'tool');
			assert.deepStrictEqual(
				toolMsgs.map((m) => m.content),
				['content of /a.ts', 'wrote /a.ts', 'content of /b.ts', 'wrote /b.ts'],
			);
		});

		it('doom loop 命中时不执行该调用及其后的调用', async () => {
			const readTool = new MockProbeReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			// 第 3 步起连续相同调用：该批 [x, y] 中 x 触发 doom → x、y 都不执行
			const provider = makeProvider([
				[makeToolCallEvent('1', 'read_file', { path: '/a.ts' }), makeFinishEvent('tool_use')],
				[makeToolCallEvent('2', 'read_file', { path: '/a.ts' }), makeFinishEvent('tool_use')],
				[
					makeToolCallEvent('3', 'read_file', { path: '/a.ts' }),
					makeToolCallEvent('4', 'read_file', { path: '/b.ts' }),
					makeFinishEvent('tool_use'),
				],
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read /a.ts');

			const history = store.loadHistory('s1');
			const guidanceMsg = history.find((m) => m.role === 'user' && m.content.includes('repeatedly calling'));
			assert.ok(guidanceMsg, '应注入 doom loop 引导消息');
			assert.strictEqual(readTool.getOrder().length, 2, '第 3 批的 x 与 y 均不执行');
		});
	});
});
