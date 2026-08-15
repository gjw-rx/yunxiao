/**
 * AISDKProvider 集成测试 - 通过 mock fetch 模拟真实 OpenAI-compatible 流（Task 5.2）。
 *
 * 覆盖：
 * 1. 文本 + usage → textDelta + 一次权威 usage + finish
 * 2. DeepSeek reasoning_content → reasoningDelta
 * 3. tool call 增量合并 → toolCall
 * 4. 网络错误（fetch 拒绝）→ error 事件
 * 5. 用户取消（abort signal）→ 停止消费且不再产生事件
 *
 * 说明：AI SDK 的 OpenAI-compatible provider 使用全局 fetch，
 * 测试中重写 globalThis.fetch 拦截请求，无需真实网络。
 */
import * as assert from 'assert';
import { AISDKProvider } from '../../llm/aiSdkProvider';
import type { LLMEvent, LLMRequest } from '../../llm/types';
import type { ModelConfig } from '../../config/modelConfig';

const mockConfig: ModelConfig = {
	provider: 'openai',
	model: 'gpt-4o-mini',
	apiKey: 'sk-test-key',
	baseURL: 'https://api.openai.com/v1',
	temperature: 0.7,
	maxTokens: 4096,
	runtime: 'ai-sdk',
};

/** 用 mock fetch 响应指定的 SSE 文本 */
function mockFetchSse(sseText: string, status = 200): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sseText));
				controller.close();
			},
		});
		return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
	}) as typeof fetch;
	return () => { globalThis.fetch = original; };
}

/** 用 mock fetch 抛网络错误 */
function mockFetchThrow(error: Error): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		throw error;
	};
	return () => { globalThis.fetch = original; };
}

/** 收集生成器的所有事件 */
async function collectEvents(provider: AISDKProvider, request: LLMRequest): Promise<LLMEvent[]> {
	const events: LLMEvent[] = [];
	for await (const event of provider.chatCompletion(request)) {
		events.push(event);
	}
	return events;
}

/** 构造 DeepSeek 配置（provider 命中 deepseek） */
function deepSeekConfig(): ModelConfig {
	return { ...mockConfig, provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1' };
}

describe('AISDKProvider 集成', () => {
	it('文本流 + usage → textDelta + 一次权威 usage + finish(stop)', async () => {
		// 注意：AI SDK 要求 usage 与 finish_reason 在同一 chunk（usage-only chunk 会被校验拒绝）
		const sse =
			'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n';
		const restore = mockFetchSse(sse);
		const provider = new AISDKProvider(mockConfig);
		const events = await collectEvents(provider, {
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		});
		restore();

		const text = events.filter((e) => e.type === 'textDelta').map((e) => (e as { text: string }).text).join('');
		assert.strictEqual(text, 'hello world');
		const usageEvents = events.filter((e) => e.type === 'usage');
		assert.strictEqual(usageEvents.length, 1, '每次调用应只产生一条 usage 事件');
		assert.strictEqual((usageEvents[0] as { inputTokens: number }).inputTokens, 100);
		assert.strictEqual((usageEvents[0] as { outputTokens: number }).outputTokens, 50);
		assert.strictEqual((usageEvents[0] as { totalTokens?: number }).totalTokens, 150);
		const finish = events.find((e) => e.type === 'finish') as { reason: string } | undefined;
		assert.ok(finish, '应产生 finish 事件');
		assert.strictEqual(finish.reason, 'stop');
	});

	it('DeepSeek reasoning_content → reasoningDelta', async () => {
		const sse =
			'data: {"choices":[{"delta":{"reasoning_content":"先"}}]}\n\n' +
			'data: {"choices":[{"delta":{"reasoning_content":"分析"}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":"最终"}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
		const restore = mockFetchSse(sse);
		const provider = new AISDKProvider(deepSeekConfig());
		const events = await collectEvents(provider, {
			model: 'deepseek-chat',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		});
		restore();

		const reasoning = events.filter((e) => e.type === 'reasoningDelta').map((e) => (e as { text: string }).text).join('');
		assert.strictEqual(reasoning, '先分析');
		const text = events.filter((e) => e.type === 'textDelta').map((e) => (e as { text: string }).text).join('');
		assert.strictEqual(text, '最终');
	});

	it('tool call 增量合并 → toolCall 事件', async () => {
		// AI SDK 要求 function.name 在首个 delta 完整提供（后续 delta 只拼接 arguments）
		const sse =
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read_file","arguments":"{\\"path\\":"}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"/tmp/a.ts\\"}"}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';
		const restore = mockFetchSse(sse);
		const provider = new AISDKProvider(mockConfig);
		const events = await collectEvents(provider, {
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'read file' }],
			tools: [{ name: 'fs_read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
			toolChoice: 'auto',
			stream: true,
		});
		restore();

		const toolCallEvents = events.filter((e) => e.type === 'toolCall');
		assert.strictEqual(toolCallEvents.length, 1);
		const tc = toolCallEvents[0] as { id: string; name: string; arguments: string };
		assert.strictEqual(tc.id, 'call_1');
		assert.strictEqual(tc.name, 'fs_read_file');
		assert.deepStrictEqual(JSON.parse(tc.arguments), { path: '/tmp/a.ts' });
		const finish = events.find((e) => e.type === 'finish') as { reason: string } | undefined;
		assert.strictEqual(finish?.reason, 'tool_use');
	});

	it('网络错误（fetch 拒绝）→ error 事件', async () => {
		const restore = mockFetchThrow(new Error('connection refused'));
		const provider = new AISDKProvider(mockConfig);
		const events = await collectEvents(provider, {
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		});
		restore();

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].type, 'error');
		assert.ok((events[0] as { error: string }).error.includes('connection refused'));
	});

	it('HTTP 401 → error 事件', async () => {
		const restore = mockFetchSse('{"error":{"message":"invalid api key"}}', 401);
		const provider = new AISDKProvider(mockConfig);
		const events = await collectEvents(provider, {
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		});
		restore();

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].type, 'error');
	});

	it('用户取消（abort）→ 停止消费且不再产生事件', async () => {
		// 流持续输出：首段后中断，模拟用户取消
		const sse =
			'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":" more"}}]}\n\n';
		const restore = mockFetchSse(sse);
		const provider = new AISDKProvider(mockConfig);
		const controller = new AbortController();

		const gen = provider.chatCompletion({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
			abortSignal: controller.signal,
		});

		const events: LLMEvent[] = [];
		// 消费第一个事件后立即取消
		const first = await gen.next();
		if (!first.done) {
			events.push(first.value);
		}
		controller.abort();

		// 取消后不再产生任何事件（generator 应结束且无 error/finish 事件）
		const rest: LLMEvent[] = [];
		for await (const event of gen) {
			rest.push(event);
		}
		restore();

		const all = [...events, ...rest];
		assert.ok(all.length >= 1, '应至少消费到首段文本');
		assert.ok(all.every((e) => e.type !== 'error'), '取消不应产生 error 事件');
		assert.ok(all.every((e) => e.type !== 'finish'), '取消不应产生 finish 事件');
	});

	it('usage 含 cache 明细 → usage 事件透传 cacheReadTokens', async () => {
		const sse =
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"prompt_tokens_details":{"cached_tokens":40}}}\n\n';
		const restore = mockFetchSse(sse);
		const provider = new AISDKProvider(mockConfig);
		const events = await collectEvents(provider, {
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		});
		restore();

		const usage = events.find((e) => e.type === 'usage') as { cacheReadTokens?: number } | undefined;
		assert.ok(usage, '应产生 usage 事件');
		assert.strictEqual(usage.cacheReadTokens, 40);
	});
});
