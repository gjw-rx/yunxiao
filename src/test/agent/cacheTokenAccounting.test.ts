/**
 * Token 记账回归测试 - AI SDK usage 归一化后的记账行为（Task 4.4）。
 *
 * 覆盖：
 * 1. usage 含 cache read/write 明细 → 快照保留 cache_read_tokens / cache_write_tokens
 * 2. usage 不含 cache 明细 → 快照不出现 cache 字段（不发明造值）
 * 3. usage 缺失 → source=estimated，估算 input_length
 * 4. usage 缺 reasoningTokens → 对 reasoning 增量文本估算，source 标记为 estimated
 * 5. 会话累计仍正确（跨多步累加）
 */
import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { MessageStore } from '../../memory/messageStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import type { LLMProvider, LLMEvent } from '../../llm/types';
import type { AgentEvent } from '../../core/eventBus';
import type { Message } from '../../memory/types';

function makeUsageEvent(
	input: number,
	output: number,
	opts?: {
		reasoning?: number;
		total?: number;
		cacheRead?: number;
		cacheWrite?: number;
		noCache?: number;
	},
): LLMEvent {
	return {
		type: 'usage',
		inputTokens: input,
		outputTokens: output,
		...(opts?.reasoning !== undefined ? { reasoningTokens: opts.reasoning } : {}),
		...(opts?.total !== undefined ? { totalTokens: opts.total } : {}),
		...(opts?.cacheRead !== undefined ? { cacheReadTokens: opts.cacheRead } : {}),
		...(opts?.cacheWrite !== undefined ? { cacheWriteTokens: opts.cacheWrite } : {}),
		...(opts?.noCache !== undefined ? { noCacheTokens: opts.noCache } : {}),
	};
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

function makeAgentLoop(
	provider: LLMProvider,
): { loop: AgentLoop; store: MessageStore; events: unknown[] } {
	const store = new MessageStore();
	const events: unknown[] = [];
	const eventBus = new EventBus();
	const originalEmit = eventBus.emit.bind(eventBus);
	eventBus.emit = (e: AgentEvent) => {
		events.push(e);
		return originalEmit(e);
	};
	const toolRegistry = new ToolRegistry();
	const router = new ToolRouter(toolRegistry);
	const loop = new AgentLoop(provider, store, router, toolRegistry, eventBus, {
		model: 'test-model',
		temperature: 0,
		maxTokens: 4096,
		maxSteps: 25,
		workspaceRoots: ['/test'],
	} as never);
	return { loop, store, events };
}

function assistantTokenUsage(store: MessageStore, sessionId: string): Array<Record<string, unknown>> {
	return store
		.loadHistory(sessionId)
		.filter((m) => m.role === 'assistant')
		.map((m) => (m as { tokenUsage?: Record<string, unknown> }).tokenUsage ?? {});
}

describe('AgentLoop token 记账（AI SDK usage 归一化）', () => {
	it('usage 含 cache 明细 → 快照保留 cache_read_tokens / cache_write_tokens', async () => {
		const provider = makeProvider([
			[makeUsageEvent(100, 50, { reasoning: 20, total: 150, cacheRead: 40, cacheWrite: 5 }), { type: 'textDelta' as const, text: 'ok' }, { type: 'finish' as const, reason: 'stop' as const }],
		]);
		const { loop, store } = makeAgentLoop(provider);
		await loop.run('s1', 'hello world this is a user message');

		const usage = assistantTokenUsage(store, 's1')[0];
		assert.strictEqual(usage.cache_read_tokens, 40);
		assert.strictEqual(usage.cache_write_tokens, 5);
		assert.strictEqual(usage.source, 'usage');
	});

	it('usage 不含 cache 明细 → 快照不出现 cache 字段（不发明造值）', async () => {
		const provider = makeProvider([
			[makeUsageEvent(100, 50, { reasoning: 20, total: 150 }), { type: 'textDelta' as const, text: 'ok' }, { type: 'finish' as const, reason: 'stop' as const }],
		]);
		const { loop, store } = makeAgentLoop(provider);
		await loop.run('s1', 'hi');

		const usage = assistantTokenUsage(store, 's1')[0];
		assert.strictEqual(usage.cache_read_tokens, undefined);
		assert.strictEqual(usage.cache_write_tokens, undefined);
		assert.strictEqual(usage.prompt_tokens, 100);
		assert.strictEqual(usage.total_tokens, 150);
	});

	it('usage 缺失 → source=estimated 且 token_usage 事件估算 input_length', async () => {
		const provider = makeProvider([
			[{ type: 'textDelta' as const, text: 'hello there' }, { type: 'finish' as const, reason: 'stop' as const }],
		]);
		const { loop, store, events } = makeAgentLoop(provider);
		await loop.run('s1', 'hi');

		const usage = assistantTokenUsage(store, 's1')[0];
		assert.strictEqual(usage.source, 'estimated');
		assert.ok((usage.total_tokens as number) > 0);

		const tuEvent = events.find((e) => (e as { type: string }).type === 'token_usage') as
			{ payload?: { source?: string; input_length?: number } };
		assert.strictEqual(tuEvent.payload?.source, 'estimated');
		assert.ok((tuEvent.payload?.input_length ?? 0) > 0, 'input_length 不应为 0');
	});

	it('usage 缺 reasoningTokens → 用 reasoning 增量文本估算并标记 estimated', async () => {
		// reasoning 增量 20 字符 → ceil(20/4)=5 token
		const provider = makeProvider([
			[
				{ type: 'reasoningDelta' as const, text: 'abcdefghijklmnopqrst' },
				{ type: 'textDelta' as const, text: 'reply' },
				makeUsageEvent(100, 50, { total: 150 }),
				{ type: 'finish' as const, reason: 'stop' as const },
			],
		]);
		const { loop, store } = makeAgentLoop(provider);
		await loop.run('s1', 'hi');

		const usage = assistantTokenUsage(store, 's1')[0];
		// usage.reasoningTokens 缺失 → reasoning 取估算值 5
		assert.strictEqual(usage.reasoning, 5);
		// 快照的 reasoning_tokens 字段来自 usage，缺失则不写
		assert.strictEqual(usage.reasoning_tokens, undefined);
	});

	it('会话累计跨多步正确累加', async () => {
		const provider = makeProvider([
			[makeUsageEvent(100, 20, { total: 120 }), { type: 'textDelta' as const, text: 'one' }, { type: 'finish' as const, reason: 'stop' as const }],
			[makeUsageEvent(200, 30, { total: 230 }), { type: 'textDelta' as const, text: 'two' }, { type: 'finish' as const, reason: 'stop' as const }],
		]);
		const { loop, events } = makeAgentLoop(provider);
		await loop.run('s1', 'first');
		await loop.run('s1', 'second');

		const evts = events.filter((e) => (e as { type: string }).type === 'session_token_usage') as
			{ payload?: { total_tokens: number; delta_tokens: number } }[];
		assert.strictEqual(evts.length, 2);
		assert.strictEqual(evts[0].payload?.total_tokens, 120);
		assert.strictEqual(evts[1].payload?.total_tokens, 350);
		assert.strictEqual(evts[1].payload?.delta_tokens, 230);
	});

	it('用户日志场景 11583/105/11688/-59/11392：负 reasoning 由 adapter 拒绝后按增量估算，cacheRead 落快照且 total 保留', async () => {
		// aiSdkStreamAdapter 已拒绝 -59，AgentLoop 收到的 usage 事件不含 reasoningTokens；11392 ≤ 11583 有效保留
		const provider = makeProvider([
			[
				{ type: 'reasoningDelta' as const, text: 'abc' },
				{ type: 'textDelta' as const, text: 'ok' },
				makeUsageEvent(11583, 105, { total: 11688, cacheRead: 11392 }),
				{ type: 'finish' as const, reason: 'stop' as const },
			],
		]);
		const { loop, store, events } = makeAgentLoop(provider);
		await loop.run('s1', 'user prompt');

		const usage = assistantTokenUsage(store, 's1')[0];
		assert.strictEqual(usage.prompt_tokens, 11583);
		assert.strictEqual(usage.completion_tokens, 105);
		assert.strictEqual(usage.total_tokens, 11688, 'provider total 原样保留');
		assert.strictEqual(usage.cache_read_tokens, 11392, '有效缓存读取落快照');
		assert.strictEqual(usage.reasoning_tokens, undefined, '负 reasoning 不落快照');
		assert.strictEqual(usage.reasoning, 1, 'reasoning 按增量文本估算（3 字符 → ceil(3/4)=1）');
		assert.strictEqual(usage.source, 'usage');

		const sessionEvt = events.filter((e) => (e as { type: string }).type === 'session_token_usage') as
			{ payload?: { total_tokens: number; cache_read_tokens?: number } }[];
		assert.strictEqual(sessionEvt[0].payload?.total_tokens, 11688, 'cache 不计入 total');
		assert.strictEqual(sessionEvt[0].payload?.cache_read_tokens, 11392, '缓存读取作为输入侧明细汇总');
	});

	it('usage 返回合法 0 的 reasoning → 快照保留 0（不按增量文本估算）', async () => {
		const provider = makeProvider([
			[
				{ type: 'reasoningDelta' as const, text: 'long thinking text' },
				{ type: 'textDelta' as const, text: 'ok' },
				makeUsageEvent(100, 50, { reasoning: 0, total: 150 }),
				{ type: 'finish' as const, reason: 'stop' as const },
			],
		]);
		const { loop, store } = makeAgentLoop(provider);
		await loop.run('s1', 'hi');

		const usage = assistantTokenUsage(store, 's1')[0];
		assert.strictEqual(usage.reasoning_tokens, 0);
		assert.strictEqual(usage.reasoning, 0, '合法 0 保留，不按增量文本估算');
	});

	it('跨步骤缓存汇总：cacheRead/cacheWrite/noCache 累加且不重复计入 total', async () => {
		const provider = makeProvider([
			[makeUsageEvent(100, 50, { total: 150, cacheRead: 40, noCache: 60 }), { type: 'textDelta' as const, text: 'one' }, { type: 'finish' as const, reason: 'stop' as const }],
			[makeUsageEvent(200, 60, { total: 260, cacheRead: 90, cacheWrite: 10, noCache: 110 }), { type: 'textDelta' as const, text: 'two' }, { type: 'finish' as const, reason: 'stop' as const }],
		]);
		const { loop, events } = makeAgentLoop(provider);
		await loop.run('s1', 'first');
		await loop.run('s1', 'second');

		const evts = events.filter((e) => (e as { type: string }).type === 'session_token_usage') as
			{ payload?: { total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; no_cache_tokens?: number } }[];
		assert.strictEqual(evts[0].payload?.total_tokens, 150);
		assert.strictEqual(evts[0].payload?.cache_read_tokens, 40);
		assert.strictEqual(evts[1].payload?.total_tokens, 410, 'total 不重复计 cache');
		assert.strictEqual(evts[1].payload?.cache_read_tokens, 130, 'cacheRead 跨步骤累加');
		assert.strictEqual(evts[1].payload?.cache_write_tokens, 10, 'cacheWrite 跨步骤累加');
		assert.strictEqual(evts[1].payload?.no_cache_tokens, 170, 'noCache 跨步骤累加');
	});

	it('input 兜底为 0 时 prompt 按请求体估算（非法 input 不污染账本）', async () => {
		// adapter 将非法 input 兜底为 0；output 有效时 hasUsage=true，但 prompt 应估算而非取 0
		const provider = makeProvider([
			[
				{ type: 'textDelta' as const, text: 'ok' },
				makeUsageEvent(0, 50, { total: 50 }),
				{ type: 'finish' as const, reason: 'stop' as const },
			],
		]);
		const { loop, store } = makeAgentLoop(provider);
		await loop.run('s1', 'user prompt here');

		const usage = assistantTokenUsage(store, 's1')[0];
		assert.ok((usage.prompt_tokens as number) > 0, 'input=0 时 prompt 应按请求体估算而非取 0');
		assert.strictEqual(usage.completion_tokens, 50);
	});

	it('output 兜底为 0 时 completion 按正文估算（非法 output 不污染账本）', async () => {
		const provider = makeProvider([
			[
				{ type: 'textDelta' as const, text: 'hello world' },
				makeUsageEvent(100, 0, { total: 100 }),
				{ type: 'finish' as const, reason: 'stop' as const },
			],
		]);
		const { loop, store } = makeAgentLoop(provider);
		await loop.run('s1', 'hi');

		const usage = assistantTokenUsage(store, 's1')[0];
		assert.strictEqual(usage.prompt_tokens, 100);
		assert.ok((usage.completion_tokens as number) > 0, 'output=0 时 completion 应按正文估算而非取 0');
	});

	it('无缓存/无 reasoning 明细时：快照与 session payload 不出现被拒绝字段', async () => {
		const provider = makeProvider([
			[makeUsageEvent(100, 50, { total: 150 }), { type: 'textDelta' as const, text: 'ok' }, { type: 'finish' as const, reason: 'stop' as const }],
		]);
		const { loop, store, events } = makeAgentLoop(provider);
		await loop.run('s1', 'hi');

		const usage = assistantTokenUsage(store, 's1')[0];
		assert.strictEqual(usage.cache_read_tokens, undefined);
		assert.strictEqual(usage.cache_write_tokens, undefined);
		assert.strictEqual(usage.no_cache_tokens, undefined);
		assert.strictEqual(usage.reasoning_tokens, undefined);

		const sessionEvt = events.find((e) => (e as { type: string }).type === 'session_token_usage') as
			{ payload?: { cache_read_tokens?: number; cache_write_tokens?: number; no_cache_tokens?: number } };
		assert.strictEqual(sessionEvt.payload?.cache_read_tokens, undefined, '无缓存数据时 session payload 省略缓存字段');
		assert.strictEqual(sessionEvt.payload?.cache_write_tokens, undefined);
		assert.strictEqual(sessionEvt.payload?.no_cache_tokens, undefined);
	});
});
