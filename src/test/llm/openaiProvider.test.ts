import * as assert from 'assert';
import { OpenAIProvider } from '../../llm/openaiProvider';
import type { LLMEvent } from '../../llm/types';
import type { ModelConfig } from '../../config/modelConfig';

const mockConfig: ModelConfig = {
	provider: 'openai',
	model: 'gpt-4o-mini',
	apiKey: 'sk-test-key',
	baseURL: 'https://api.openai.com/v1',
	temperature: 0.7,
	maxTokens: 4096,
};

/** 记录 fetch 调用参数 */
interface FetchCall {
	url: string;
	init: RequestInit;
}

/** 创建 mock fetch，返回指定的 SSE 响应 */
function mockFetch(sseText: string, status = 200): { calls: FetchCall[]; restore: () => void } {
	const calls: FetchCall[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sseText));
				controller.close();
			},
		});
		return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 创建 mock fetch，返回 HTTP 错误 */
function mockFetchError(status: number, body: string): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
		return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
	};
	return () => { globalThis.fetch = original; };
}

/** 创建 mock fetch，抛出网络错误 */
function mockFetchThrow(error: Error): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
		throw error;
	};
	return () => { globalThis.fetch = original; };
}

async function collectEvents(gen: AsyncGenerator<LLMEvent>): Promise<LLMEvent[]> {
	const events: LLMEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

describe('OpenAIProvider', () => {
	it('构建正确的请求体', async () => {
		const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider(mockConfig);

		await collectEvents(provider.chatCompletion({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hello' }],
			tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
			toolChoice: 'auto',
			stream: true,
		}));

		restore();

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/chat/completions');
		const body = JSON.parse(calls[0].init.body as string);
		assert.strictEqual(body.model, 'gpt-4o-mini');
		assert.strictEqual(body.stream, true);
		assert.strictEqual(body.messages[0].role, 'user');
		assert.strictEqual(body.messages[0].content, 'hello');
		assert.strictEqual(body.tools[0].type, 'function');
		assert.strictEqual(body.tools[0].function.name, 'read_file');
		assert.strictEqual(body.tool_choice, 'auto');
	});

	it('设置 Authorization header', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider(mockConfig);

		await collectEvents(provider.chatCompletion({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		}));

		restore();
		const headers = calls[0].init.headers as Record<string, string>;
		assert.strictEqual(headers['Authorization'], 'Bearer sk-test-key');
		assert.strictEqual(headers['Content-Type'], 'application/json');
	});

	it('处理非 OK HTTP 响应', async () => {
		const restore = mockFetchError(401, '{"error":"invalid api key"}');
		const provider = new OpenAIProvider(mockConfig);

		const events = await collectEvents(provider.chatCompletion({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		}));

		restore();
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].type, 'error');
		assert.ok((events[0] as { error: string }).error.includes('401'));
	});

	it('处理网络错误', async () => {
		const restore = mockFetchThrow(new Error('connection refused'));
		const provider = new OpenAIProvider(mockConfig);

		const events = await collectEvents(provider.chatCompletion({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		}));

		restore();
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].type, 'error');
		assert.ok((events[0] as { error: string }).error.includes('connection refused'));
	});

	it('正确转换 assistant 消息含 toolCalls', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider(mockConfig);

		await collectEvents(provider.chatCompletion({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'user', content: 'read file' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"test.ts"}' }] },
				{ role: 'tool', toolCallId: 'call_1', content: 'file content' },
			],
			stream: true,
		}));

		restore();
		const body = JSON.parse(calls[0].init.body as string);
		assert.strictEqual(body.messages[1].role, 'assistant');
		assert.strictEqual(body.messages[1].tool_calls[0].id, 'call_1');
		assert.strictEqual(body.messages[1].tool_calls[0].function.name, 'read_file');
		assert.strictEqual(body.messages[2].role, 'tool');
		assert.strictEqual(body.messages[2].tool_call_id, 'call_1');
	});

	it('去除 baseURL 尾部斜杠', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider({ ...mockConfig, baseURL: 'https://api.deepseek.com/v1/' });

		await collectEvents(provider.chatCompletion({
			model: 'deepseek-chat',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		}));

		restore();
		assert.strictEqual(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
	});

	it('DeepSeek 请求带 thinking.enabled + reasoning_effort', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider({
			...mockConfig,
			provider: 'deepseek',
			baseURL: 'https://api.deepseek.com/v1',
		});

		await collectEvents(provider.chatCompletion({
			model: 'deepseek-v4-flash',
			messages: [{ role: 'user', content: 'hi' }],
			reasoningEffort: 'high',
			stream: true,
		}));

		restore();
		const body = JSON.parse(calls[0].init.body as string);
		assert.deepStrictEqual(body.thinking, { type: 'enabled' });
		assert.strictEqual(body.reasoning_effort, 'high');
	});

	it('DeepSeek 未设置 reasoningEffort 时默认开启思考且省略 temperature', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider({
			...mockConfig,
			provider: 'deepseek',
			baseURL: 'https://api.deepseek.com/v1',
		});

		await collectEvents(provider.chatCompletion({
			model: 'deepseek-v4-flash',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		}));

		restore();
		const body = JSON.parse(calls[0].init.body as string);
		assert.deepStrictEqual(body.thinking, { type: 'enabled' });
		assert.strictEqual(body.reasoning_effort, undefined);
		// DeepSeek 思考模式下 temperature 仅支持 1.0，应省略该字段
		assert.strictEqual(body.temperature, undefined);
	});

	it('DeepSeek minimal 档映射为 low', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider({
			...mockConfig,
			provider: 'deepseek',
			baseURL: 'https://api.deepseek.com/v1',
		});

		await collectEvents(provider.chatCompletion({
			model: 'deepseek-v4-flash',
			messages: [{ role: 'user', content: 'hi' }],
			reasoningEffort: 'minimal',
			stream: true,
		}));

		restore();
		const body = JSON.parse(calls[0].init.body as string);
		assert.deepStrictEqual(body.thinking, { type: 'enabled' });
		assert.strictEqual(body.reasoning_effort, 'low');
	});

	it('DeepSeek reasoningEffort=disabled 时发 thinking.disabled', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider({
			...mockConfig,
			provider: 'deepseek',
			baseURL: 'https://api.deepseek.com/v1',
		});

		await collectEvents(provider.chatCompletion({
			model: 'deepseek-v4-flash',
			messages: [{ role: 'user', content: 'hi' }],
			reasoningEffort: 'disabled',
			stream: true,
		}));

		restore();
		const body = JSON.parse(calls[0].init.body as string);
		assert.deepStrictEqual(body.thinking, { type: 'disabled' });
		assert.strictEqual(body.reasoning_effort, undefined);
	});

	it('OpenAI 请求带 reasoning_effort 且不带 thinking', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider(mockConfig);

		await collectEvents(provider.chatCompletion({
			model: 'gpt-5-mini',
			messages: [{ role: 'user', content: 'hi' }],
			reasoningEffort: 'medium',
			stream: true,
		}));

		restore();
		const body = JSON.parse(calls[0].init.body as string);
		assert.strictEqual(body.reasoning_effort, 'medium');
		assert.strictEqual(body.thinking, undefined);
	});

	it('未设置 reasoningEffort 时不传 reasoning 参数', async () => {
		const sse = 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const { calls, restore } = mockFetch(sse);
		const provider = new OpenAIProvider(mockConfig);

		await collectEvents(provider.chatCompletion({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		}));

		restore();
		const body = JSON.parse(calls[0].init.body as string);
		assert.strictEqual(body.reasoning_effort, undefined);
		assert.strictEqual(body.thinking, undefined);
	});
});
