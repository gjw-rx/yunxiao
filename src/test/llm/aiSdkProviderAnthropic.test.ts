/**
 * AISDKProvider Anthropic 集成测试（Task 1.1 基线 + Task 4/5 消费）。
 *
 * 通过 mock fetch 模拟真实 Anthropic Messages SSE 流，覆盖文本、reasoning、
 * 单个与并行工具调用、finish、流内错误、取消、完整 usage（含 cache creation 与大 cache read）。
 * 在 provider=anthropic 分派实现（Task 4.1）落地前，这些测试预期失败——
 * 用于建立协议回归基线（design.md Migration Plan 第 4 步）。
 */
import * as assert from 'assert';
import { AISDKProvider } from '../../llm/aiSdkProvider';
import type { LLMEvent, LLMRequest } from '../../llm/types';
import type { ModelConfig } from '../../config/modelConfig';
import { ANTHROPIC_STREAM_FIXTURES, getAnthropicFixture, type AnthropicStreamFixture } from './anthropicFixtures';

const anthropicConfig: ModelConfig = {
	provider: 'anthropic',
	model: 'claude-3-5-sonnet-latest',
	apiKey: 'sk-ant-test-key',
	baseURL: 'https://api.anthropic.com/v1',
	temperature: 0.7,
	maxTokens: 4096,
	runtime: 'ai-sdk',
};

/** 用 mock fetch 响应指定的 Anthropic SSE 文本 */
function mockFetchSse(sseText: string, status = 200): { restore: () => void; bodies: string[] } {
	const original = globalThis.fetch;
	const bodies: string[] = [];
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		if (init?.body) {
			bodies.push(String(init.body));
		}
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sseText));
				controller.close();
			},
		});
		return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
	}) as typeof fetch;
	return { restore: () => { globalThis.fetch = original; }, bodies };
}

/** 收集生成器的所有事件（取消场景下限制读取段数） */
async function collectEvents(provider: AISDKProvider, request: LLMRequest, takeCount?: number): Promise<LLMEvent[]> {
	const events: LLMEvent[] = [];
	for await (const event of provider.chatCompletion(request)) {
		events.push(event);
		if (takeCount !== undefined && events.length >= takeCount) {
			break;
		}
	}
	return events;
}

/** 按 fixture 断言归一化事件语义 */
async function runFixture(fixture: AnthropicStreamFixture): Promise<void> {
	const { restore } = mockFetchSse(fixture.sse, fixture.status ?? 200);
	const provider = new AISDKProvider(anthropicConfig);
	const events = await collectEvents(provider, {
		model: 'claude-3-5-sonnet-latest',
		messages: [{ role: 'user', content: 'hi' }],
		tools: fixture.expectedToolCalls ? [{ name: fixture.expectedToolCalls[0].name, description: '工具', parameters: { type: 'object', properties: {} } }] : undefined,
		stream: true,
	});
	restore();

	if (fixture.expectsError) {
		assert.ok(events.some((e) => e.type === 'error'), `${fixture.name} 应产生 error 事件`);
		assert.ok(!events.some((e) => e.type === 'finish'), `${fixture.name} 出错后不应产生成功 finish`);
		return;
	}

	if (fixture.expectedText !== undefined) {
		const text = events.filter((e) => e.type === 'textDelta').map((e) => (e as { text: string }).text).join('');
		assert.strictEqual(text, fixture.expectedText, `${fixture.name} 文本内容不一致`);
	}
	if (fixture.expectedReasoning !== undefined) {
		const reasoning = events.filter((e) => e.type === 'reasoningDelta').map((e) => (e as { text: string }).text).join('');
		assert.strictEqual(reasoning, fixture.expectedReasoning, `${fixture.name} reasoning 内容不一致`);
	}
	if (fixture.expectedToolCalls) {
		const toolCalls = events.filter((e) => e.type === 'toolCall') as Array<{ id: string; name: string; arguments: string }>;
		assert.strictEqual(toolCalls.length, fixture.expectedToolCalls.length, `${fixture.name} toolCall 数量不一致`);
		fixture.expectedToolCalls.forEach((expected, i) => {
			assert.strictEqual(toolCalls[i].id, expected.id, `${fixture.name} 第 ${i} 个 toolCall id 不一致`);
			assert.strictEqual(toolCalls[i].name, expected.name, `${fixture.name} 第 ${i} 个 toolCall name 不一致`);
			assert.deepStrictEqual(JSON.parse(toolCalls[i].arguments), JSON.parse(expected.arguments), `${fixture.name} 第 ${i} 个 toolCall arguments 不一致`);
		});
	}
	if (fixture.expectedFinishReason !== undefined) {
		const finish = events.find((e) => e.type === 'finish') as { reason: string } | undefined;
		assert.strictEqual(finish?.reason, fixture.expectedFinishReason, `${fixture.name} finish reason 不一致`);
	}
	if (fixture.expectedUsage) {
		const usageEvents = events.filter((e) => e.type === 'usage');
		assert.strictEqual(usageEvents.length, 1, `${fixture.name} 每次调用应只产生一条 usage 事件`);
		const usage = usageEvents[0] as unknown as Record<string, number | undefined>;
		assert.strictEqual(usage.inputTokens, fixture.expectedUsage.inputTokens, `${fixture.name} inputTokens 不一致`);
		assert.strictEqual(usage.outputTokens, fixture.expectedUsage.outputTokens, `${fixture.name} outputTokens 不一致`);
		assert.strictEqual(usage.totalTokens, fixture.expectedUsage.totalTokens, `${fixture.name} totalTokens 不一致`);
		assert.strictEqual(usage.noCacheTokens, fixture.expectedUsage.noCacheTokens, `${fixture.name} noCacheTokens 不一致`);
		assert.strictEqual(usage.cacheReadTokens, fixture.expectedUsage.cacheReadTokens, `${fixture.name} cacheReadTokens 不一致`);
		assert.strictEqual(usage.cacheWriteTokens, fixture.expectedUsage.cacheWriteTokens, `${fixture.name} cacheWriteTokens 不一致`);
		assert.strictEqual(usage.reasoningTokens, fixture.expectedUsage.reasoningTokens, `${fixture.name} reasoningTokens 不一致`);
	}
}

describe('AISDKProvider Anthropic 集成（离线 fixture 回归基线）', () => {
	for (const fixture of ANTHROPIC_STREAM_FIXTURES) {
		if (fixture.name === 'anthropic-cancelled-stream') {
			continue; // 取消场景单独测试（需要真实 AbortController）
		}
		it(`fixture: ${fixture.name}`, async () => {
			await runFixture(fixture);
		});
	}

	it('用户取消 Anthropic 请求：abort 后不再产生事件', async () => {
		const fixture = ANTHROPIC_STREAM_FIXTURES.find((f) => f.name === 'anthropic-cancelled-stream')!;
		const { restore } = mockFetchSse(fixture.sse);
		const provider = new AISDKProvider(anthropicConfig);
		const abortController = new AbortController();
		const events: LLMEvent[] = [];
		for await (const event of provider.chatCompletion({
			model: 'claude-3-5-sonnet-latest',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
			abortSignal: abortController.signal,
		})) {
			events.push(event);
			if (events.length === 1) {
				abortController.abort();
			}
		}
		restore();
		assert.ok(!events.some((e) => e.type === 'finish'), '取消后不应产生 finish 事件');
		const text = events.filter((e) => e.type === 'textDelta').map((e) => (e as { text: string }).text).join('');
		assert.ok(!text.includes('should not appear'), '取消后不应继续分发后续文本');
	});

	it('Anthropic 请求在最后一个可缓存内容块注入 ephemeral cache breakpoint', async () => {
		const sse = getAnthropicFixture('anthropic-plain-text').sse;
		const { restore, bodies } = mockFetchSse(sse);
		const provider = new AISDKProvider(anthropicConfig);
		await runViaProvider(provider);
		restore();

		const body = JSON.parse(bodies[0]);
		const lastContent = body.messages[body.messages.length - 1].content;
		const lastBlock = Array.isArray(lastContent) ? lastContent[lastContent.length - 1] : lastContent;
		assert.deepStrictEqual(lastBlock.cache_control, { type: 'ephemeral' }, '最后一个可缓存内容块应带 5 分钟 ephemeral breakpoint');
	});

	it('OpenAI-compatible 请求不携带 Anthropic cacheControl 或其他 metadata', async () => {
		// OpenAI-compatible 端点返回标准 Chat Completions SSE
		const sse =
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
		const { restore, bodies } = mockFetchSse(sse);
		const provider = new AISDKProvider({
			provider: 'openai',
			model: 'gpt-4o-mini',
			apiKey: 'sk-test',
			baseURL: 'https://api.openai.com/v1',
			temperature: 0.7,
			maxTokens: 4096,
			runtime: 'ai-sdk',
		});
		await runViaProvider(provider);
		restore();

		const body = JSON.parse(bodies[0]);
		const serialized = JSON.stringify(body);
		assert.ok(!serialized.includes('cache_control'), 'OpenAI-compatible 请求不得携带 Anthropic cacheControl');
		assert.ok(!serialized.includes('cacheControl'), 'OpenAI-compatible 请求不得携带 Anthropic cacheControl 元数据');
		assert.ok(!serialized.includes('output_config'), 'OpenAI-compatible 请求不得携带 Anthropic metadata');
	});

	it('Anthropic 三档推理强度原样映射为原生 effort，未设置时不携带', async () => {
		const sse = getAnthropicFixture('anthropic-plain-text').sse;
		const cases = [
			{ effort: 'low' as const, expected: 'low' },
			{ effort: 'medium' as const, expected: 'medium' },
			{ effort: 'high' as const, expected: 'high' },
		];
		for (const { effort, expected } of cases) {
			const { restore, bodies } = mockFetchSse(sse);
			const provider = new AISDKProvider(anthropicConfig);
			await runViaProvider(provider, { reasoningEffort: effort });
			restore();
			const body = JSON.parse(bodies[0]);
			assert.strictEqual(body?.output_config?.effort, expected, `${effort} 档应原样映射为 ${expected}`);
		}

		// 未设置档位时不携带 effort
		const { restore, bodies } = mockFetchSse(sse);
		const provider = new AISDKProvider(anthropicConfig);
		await runViaProvider(provider);
		restore();
		const body = JSON.parse(bodies[0]);
		assert.strictEqual(body?.output_config?.effort, undefined, '未设置档位不应携带 effort');
	});

	it('Anthropic 三档推理强度不向 OpenAI-compatible 泄漏（provider options 隔离）', async () => {
		const sse =
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
		for (const effort of ['low', 'medium', 'high'] as const) {
			const { restore, bodies } = mockFetchSse(sse);
			const provider = new AISDKProvider({
				provider: 'openai',
				model: 'gpt-4o-mini',
				apiKey: 'sk-test',
				baseURL: 'https://api.openai.com/v1',
				temperature: 0.7,
				maxTokens: 4096,
				runtime: 'ai-sdk',
			});
			await runViaProvider(provider, { reasoningEffort: effort });
			restore();
			const body = JSON.parse(bodies[0]);
			assert.strictEqual(body?.output_config, undefined, `档位 ${effort} 不得向 OpenAI-compatible 泄漏 Anthropic effort`);
			assert.strictEqual(body?.reasoning_effort, effort, 'OpenAI-compatible 应使用其自身 reasoning_effort');
		}
	});
});

/** 消费一次完整调用，收集全部事件（供请求体断言）。 */
async function runViaProvider(provider: AISDKProvider, requestOverrides: Partial<LLMRequest> = {}): Promise<LLMEvent[]> {
	const events: LLMEvent[] = [];
	for await (const event of provider.chatCompletion({
		model: 'claude-3-5-sonnet-latest',
		messages: [{ role: 'user', content: 'hi' }],
		stream: true,
		...requestOverrides,
	})) {
		events.push(event);
	}
	return events;
}
