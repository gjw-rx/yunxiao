import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { MessageStore } from '../../memory/messageStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import type { LLMProvider, LLMEvent } from '../../llm/types';
import type { ToolSchema, ToolCall, ToolResult, ToolCallStatus } from '../../core/types';
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

// ── Mock LLM Provider ──

function makeToolCallEvent(id: string, name: string, args: Record<string, unknown>): LLMEvent {
	return { type: 'toolCall', id, name, arguments: JSON.stringify(args) };
}

function makeTextEvent(text: string): LLMEvent {
	return { type: 'textDelta', text };
}

function makeFinishEvent(): LLMEvent {
	return { type: 'finish', reason: 'stop' };
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
		repeatThreshold: 3,
		cacheReadTools: true,
		...configOverrides,
	} as never);

	return { loop, store, events };
}

// ── 测试 ──

describe('AgentLoop convergence', () => {
	describe('P0: 重复调用检测', () => {
		it('连续重复达阈值时注入引导消息', async () => {
			const readTool = new MockReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			// 3 次相同调用 → 第 3 次触发引导，第 4 次无工具调用 → 结束
			const provider = makeProvider([
				[makeToolCallEvent('1', 'read_file', { path: '/a.ts' }), makeFinishEvent()],
				[makeToolCallEvent('2', 'read_file', { path: '/a.ts' }), makeFinishEvent()],
				[makeToolCallEvent('3', 'read_file', { path: '/a.ts' }), makeFinishEvent()], // 第3次 → 引导
				[makeTextEvent('Done'), makeFinishEvent()], // 无工具调用 → 结束
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read /a.ts');

			const history = store.loadHistory('s1');
			// 应存在引导消息
			const guidanceMsg = history.find(
				(m) => m.role === 'user' && m.content.includes('repeatedly calling'),
			);
			assert.ok(guidanceMsg, '应注入引导消息');
			// read_file 实际只执行了 1 次（第 2 次命中缓存，第 3 次被重复检测拦截）
			assert.strictEqual(readTool.getCallCount(), 1);
		});
	});

	describe('P5: 工具结果缓存', () => {
		it('缓存命中时跳过执行', async () => {
			const readTool = new MockReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			// 第1次：调用 read_file → 执行 → 缓存
			// 第2次：调用相同参数 read_file → 缓存命中 → 跳过
			// 第3次：无工具调用 → 结束
			const provider = makeProvider([
				[makeToolCallEvent('1', 'read_file', { path: '/a.ts' }), makeFinishEvent()],
				[makeToolCallEvent('2', 'read_file', { path: '/a.ts' }), makeFinishEvent()],
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop, store } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'read /a.ts');

			// read_file 只执行了 1 次（第 2 次命中缓存）
			assert.strictEqual(readTool.getCallCount(), 1);
			// 第 2 次的 tool 消息应包含 [cached]
			const history = store.loadHistory('s1');
			const cachedToolMsg = history.find(
				(m) => m.role === 'tool' && m.content.includes('[cached]'),
			);
			assert.ok(cachedToolMsg, '应存在 [cached] 前缀的 tool 消息');
		});

		it('write 工具不被缓存', async () => {
			const writeTool = new MockWriteTool();
			const registry = new ToolRegistry();
			registry.register(writeTool);

			const provider = makeProvider([
				[makeToolCallEvent('1', 'write_file', { path: '/a.ts', content: 'x' }), makeFinishEvent()],
				[makeToolCallEvent('2', 'write_file', { path: '/a.ts', content: 'x' }), makeFinishEvent()],
				[makeTextEvent('Done'), makeFinishEvent()],
			]);

			const { loop } = makeAgentLoop(provider, registry);
			await loop.run('s1', 'write /a.ts');

			// write_file 应执行 2 次（不被缓存）
			assert.strictEqual(writeTool.getCallCount(), 2);
		});
	});

	describe('P3: 步数预警', () => {
		it('达到 80% maxSteps 时注入预警', async () => {
			const readTool = new MockReadTool();
			const registry = new ToolRegistry();
			registry.register(readTool);

			// maxSteps=5, 80% = 4
			// 5 次工具调用（不同参数避免重复检测 + 不命中缓存）
			// 第 5 次达到 maxSteps → MAX_STEPS_PROMPT
			// 第 6 次无工具调用 → 结束
			const events: LLMEvent[][] = [];
			for (let i = 0; i < 5; i++) {
				events.push([
					makeToolCallEvent(`${i}`, 'read_file', { path: `/file${i}.ts` }),
					makeFinishEvent(),
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
});
