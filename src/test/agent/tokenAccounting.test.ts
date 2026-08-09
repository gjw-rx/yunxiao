import * as assert from 'assert';
import { AgentLoop } from '../../agent/agentLoop';
import { MessageStore } from '../../memory/messageStore';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import type { LLMProvider, LLMEvent } from '../../llm/types';
import type { ToolSchema, ToolCallStatus } from '../../core/types';
import { BaseTool } from '../../tools/baseTool';
import type { AgentEvent } from '../../core/eventBus';
import type { Message } from '../../memory/types';

function makeTextEvent(text: string): LLMEvent {
	return { type: 'textDelta', text };
}

function makeReasoningEvent(text: string): LLMEvent {
	return { type: 'reasoningDelta', text };
}

function makeToolCallEvent(id: string, name: string, args: Record<string, unknown>): LLMEvent {
	return { type: 'toolCall', id, name, arguments: JSON.stringify(args) };
}

function makeFinishEvent(reason: 'stop' | 'tool_use' | 'length' = 'stop'): LLMEvent {
	return { type: 'finish', reason };
}

function makeUsageEvent(
	input: number,
	output: number,
	opts?: { reasoning?: number; total?: number },
): LLMEvent {
	return {
		type: 'usage',
		inputTokens: input,
		outputTokens: output,
		...(opts?.reasoning !== undefined ? { reasoningTokens: opts.reasoning } : {}),
		...(opts?.total !== undefined ? { totalTokens: opts.total } : {}),
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
	registry?: ToolRegistry,
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

	const toolRegistry = registry ?? new ToolRegistry();
	const router = new ToolRouter(toolRegistry);

	const loop = new AgentLoop(provider, store, router, toolRegistry, eventBus, {
		model: 'test-model',
		temperature: 0,
		maxTokens: 4096,
		maxSteps: 25,
		workspaceRoots: ['/test'],
		...configOverrides,
	} as never);

	return { loop, store, events };
}

function assistantMessages(store: MessageStore, sessionId: string): Message[] {
	return store.loadHistory(sessionId).filter((m) => m.role === 'assistant');
}

describe('AgentLoop token 记账', () => {
	it('无工具调用：思考用 usage、模型回复为剩余值、用户输入为分摊值', async () => {
		// prompt=1000, completion=50, reasoning=20；正文 8 字符 → 估算 2 token
		const provider = makeProvider([
			[makeReasoningEvent('thinking text'), makeTextEvent('reply!!'), makeFinishEvent(), makeUsageEvent(1000, 50, { reasoning: 20, total: 1050 })],
		]);
		const { loop, store } = makeAgentLoop(provider);
		await loop.run('s1', 'hello world this is a test user message');

		const msgs = assistantMessages(store, 's1');
		assert.strictEqual(msgs.length, 1);
		const tu = (msgs[0] as { tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; reasoning: number; tool_calls: number; model_output: number; user_input: number; context: number; source: string } }).tokenUsage;
		assert.ok(tu, 'assistant 消息应携带 tokenUsage');
		assert.strictEqual(tu.prompt_tokens, 1000);
		assert.strictEqual(tu.completion_tokens, 50);
		assert.strictEqual(tu.total_tokens, 1050);
		assert.strictEqual(tu.reasoning, 20); // usage.reasoning_tokens
		assert.strictEqual(tu.tool_calls, 0);
		// model_output = 50 - 20 - 0 = 30
		assert.strictEqual(tu.model_output, 30);
		// context = prompt - user_input；user_input 为分摊值（估算）
		assert.ok(tu.user_input > 0);
		assert.strictEqual(tu.context, tu.prompt_tokens - tu.user_input);
		assert.strictEqual(tu.source, 'usage');
	});

	it('含工具调用：工具 token 为 name+arguments 估算，模型回复为剩余值', async () => {
		// 工具调用参数 12 字符 + name 9 字符 = 21 → 估算 ceil(21/4)=6
		class MockReadTool extends BaseTool {
			readonly schema: ToolSchema = {
				name: 'read_file',
				description: 'Read a file',
				parameters: { type: 'object', properties: { path: { type: 'string' } } },
				permissions: 'read',
				canParallel: true,
			};
			async execute(args: Record<string, unknown>): Promise<{ status: ToolCallStatus; result?: string }> {
				return { status: 'success', result: `content of ${args.path}` };
			}
		}
		const registry = new ToolRegistry();
		registry.register(new MockReadTool());
		const provider = makeProvider([
			[
				makeToolCallEvent('1', 'read_file', { path: '/tmp/a.txt' }),
				makeFinishEvent('tool_use'),
				makeUsageEvent(500, 80, { reasoning: 20, total: 580 }),
			],
			[makeTextEvent('done!'), makeFinishEvent(), makeUsageEvent(600, 10, { reasoning: 0, total: 610 })],
		]);
		const { loop, store } = makeAgentLoop(provider, registry);
		await loop.run('s1', 'check file');

		const msgs = assistantMessages(store, 's1');
		assert.strictEqual(msgs.length, 2);
		const first = (msgs[0] as { tokenUsage?: { reasoning: number; tool_calls: number; model_output: number } }).tokenUsage!;
		assert.strictEqual(first.reasoning, 20);
		assert.ok(first.tool_calls > 0, '工具调用 token 应大于 0');
		// model_output = 80 - 20 - tool_calls（正文为空,可能为 0）
		assert.strictEqual(first.model_output, Math.max(0, 80 - 20 - first.tool_calls));
	});

	it('usage 缺失时走估算兜底且 source=estimated', async () => {
		const provider = makeProvider([
			[makeTextEvent('hello there'), makeFinishEvent()],
		]);
		const { loop, store, events } = makeAgentLoop(provider);
		await loop.run('s1', 'hi');

		const msgs = assistantMessages(store, 's1');
		assert.strictEqual(msgs.length, 1);
		const tu = (msgs[0] as { tokenUsage?: { source: string; total_tokens: number; model_output: number } }).tokenUsage!;
		assert.strictEqual(tu.source, 'estimated');
		assert.ok(tu.total_tokens > 0);
		// model_output 为正文估算
		assert.strictEqual(tu.model_output, Math.ceil('hello there'.length / 4));

		// 补发的 token_usage 事件 source=estimated
		const tuEvent = events.find((e) => (e as { type: string }).type === 'token_usage') as
			{ payload?: { source?: string; input_length?: number } };
		assert.strictEqual(tuEvent.payload?.source, 'estimated');
		assert.ok((tuEvent.payload?.input_length ?? 0) > 0);
	});

	it('run 结束时发射 session_token_usage 事件（会话级汇总）', async () => {
		const provider = makeProvider([
			[makeTextEvent('reply'), makeFinishEvent(), makeUsageEvent(100, 20, { reasoning: 5, total: 120 })],
		]);
		const { loop, events } = makeAgentLoop(provider);
		await loop.run('s1', 'hello');

		const evt = events.find((e) => (e as { type: string }).type === 'session_token_usage') as
			{ payload?: { total_tokens: number; breakdown: { reasoning: number; user_input: number; context: number }; delta_tokens: number } };
		assert.ok(evt, '应发射 session_token_usage 事件');
		assert.strictEqual(evt.payload?.total_tokens, 120);
		assert.strictEqual(evt.payload?.breakdown.reasoning, 5);
		assert.ok((evt.payload?.breakdown.user_input ?? 0) > 0);
		assert.strictEqual(evt.payload?.breakdown.context, 100 - (evt.payload?.breakdown.user_input ?? 0));
		assert.strictEqual(evt.payload?.delta_tokens, 120);
	});

	it('用户消息回写 inputTokens 分摊值', async () => {
		const provider = makeProvider([
			[makeTextEvent('reply'), makeFinishEvent(), makeUsageEvent(100, 10, { total: 110 })],
		]);
		const { loop, store } = makeAgentLoop(provider);
		await loop.run('s1', 'a user request here');

		const userMsg = store.loadHistory('s1').find((m) => m.role === 'user');
		assert.ok(userMsg, '应存在用户消息');
		assert.ok((userMsg as { inputTokens?: number }).inputTokens, '用户消息应回写 inputTokens');
	});

	it('会话累计跨多次 run 累加，新建会话后清零', async () => {
		const provider = makeProvider([
			[makeTextEvent('reply one'), makeFinishEvent(), makeUsageEvent(100, 10, { total: 110 })],
		]);
		const { loop, store, events } = makeAgentLoop(provider);
		// 第一次 run：total=110
		await loop.run('s1', 'first message');
		// 第二次 run 追加：history 更长但 usage 仍为 110 → 会话累计应为 220
		await loop.run('s1', 'second message');

		const evts = events.filter((e) => (e as { type: string }).type === 'session_token_usage') as
			{ payload?: { total_tokens: number; delta_tokens: number } }[];
		assert.strictEqual(evts.length, 2);
		assert.strictEqual(evts[0].payload?.total_tokens, 110);
		assert.strictEqual(evts[0].payload?.delta_tokens, 110);
		assert.strictEqual(evts[1].payload?.total_tokens, 220);
		assert.strictEqual(evts[1].payload?.delta_tokens, 110);

		// 新建会话：累计从零开始
		const s2Events: unknown[] = [];
		const s2Bus = new EventBus();
		const s2Store = new MessageStore();
		s2Bus.emit = (e: AgentEvent) => {
			s2Events.push(e);
			return (EventBus.prototype.emit as unknown as (ev: AgentEvent) => void).call(s2Bus, e);
		};
		const s2Registry = new ToolRegistry();
		const s2Loop = new AgentLoop(provider, s2Store, new ToolRouter(s2Registry), s2Registry, s2Bus, {
			model: 'test-model',
			temperature: 0,
			maxTokens: 4096,
			maxSteps: 25,
			workspaceRoots: ['/test'],
		} as never);
		await s2Loop.run('s2', 'fresh session');
		const s2Evt = s2Events.find((e) => (e as { type: string }).type === 'session_token_usage') as
			{ payload?: { total_tokens: number } };
		assert.strictEqual(s2Evt.payload?.total_tokens, 110);
	});
});
