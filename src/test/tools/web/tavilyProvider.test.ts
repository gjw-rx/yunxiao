import * as assert from 'assert';
import { TavilyWebSearchProvider } from '../../../tools/web/tavilyProvider';
import { WebSearchError, type WebSearchRequest } from '../../../tools/web/types';

/** 测试用 API Key（断言错误与日志不包含它）。 */
const API_KEY = 'tvly-test-secret-key-123';

/** 原始全局 fetch（用例后恢复，避免污染其他测试）。 */
const originalFetch = globalThis.fetch;

/** 构造标准测试请求。 */
function makeRequest(overrides: Partial<WebSearchRequest> = {}): WebSearchRequest {
	return {
		query: 'vscode extension api',
		apiKey: API_KEY,
		maxResults: 5,
		searchDepth: 'basic',
		includeDomains: [],
		excludeDomains: [],
		timeoutMs: 5_000,
		...overrides,
	};
}

/** 记录 fetch 调用参数。 */
interface FetchCall {
	url: string;
	init: RequestInit;
}

/** 创建 mock fetch，返回指定状态与 JSON 体。 */
function mockFetchJson(status: number, body: unknown): { calls: FetchCall[]; restore: () => void } {
	const calls: FetchCall[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 创建 mock fetch，返回非法 JSON 文本（JSON 解析失败场景）。 */
function mockFetchInvalidJson(status: number): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response('<html>not json</html>', { status });
	return () => { globalThis.fetch = original; };
}

/** 创建 mock fetch，抛出网络错误。 */
function mockFetchThrow(error: Error): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = async () => { throw error; };
	return () => { globalThis.fetch = original; };
}

/** 创建 mock fetch，永不返回，仅在 abort 时以 AbortError 拒绝（超时场景）。 */
function mockFetchHang(): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => {
				reject(new DOMException('The operation was aborted.', 'AbortError'));
			});
		});
	}) as typeof fetch;
	return () => { globalThis.fetch = original; };
}

/** 标准 Tavily 成功响应（含应被丢弃的额外字段）。 */
function tavilySuccessBody(): unknown {
	return {
		query: 'vscode extension api',
		answer: 'should be dropped',
		results: [
			{
				title: 'VS Code Extension API',
				url: 'https://code.visualstudio.com/api',
				content: 'Overview of the extension APIs.',
				score: 0.98,
				published_date: '2024-01-01T00:00:00.000000Z',
				raw_content: 'should be dropped',
				images: ['should be dropped'],
			},
			{
				title: 'Getting Started',
				url: 'https://code.visualstudio.com/api/get-started',
				content: 'Your first extension.',
				score: 0.91,
			},
		],
	};
}

describe('TavilyWebSearchProvider', () => {
	afterEach(() => {
		// 兜底恢复全局 fetch，避免用例间污染
		globalThis.fetch = originalFetch;
	});

	it('成功归一化：请求正确且结果仅含允许字段', async () => {
		// Arrange
		const { calls, restore } = mockFetchJson(200, tavilySuccessBody());
		const provider = new TavilyWebSearchProvider();
		const request = makeRequest({
			maxResults: 3,
			searchDepth: 'advanced',
			includeDomains: ['code.visualstudio.com'],
			excludeDomains: ['example.com'],
		});

		// Act
		const response = await provider.search(request);

		// Assert
		restore();
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, 'https://api.tavily.com/search');
		assert.strictEqual(calls[0].init.method, 'POST');
		const headers = calls[0].init.headers as Record<string, string>;
		assert.strictEqual(headers.Authorization, `Bearer ${API_KEY}`);
		const body = JSON.parse(calls[0].init.body as string);
		assert.strictEqual(body.query, 'vscode extension api');
		assert.strictEqual(body.max_results, 3);
		assert.strictEqual(body.search_depth, 'advanced');
		assert.deepStrictEqual(body.include_domains, ['code.visualstudio.com']);
		assert.deepStrictEqual(body.exclude_domains, ['example.com']);

		assert.strictEqual(response.query, 'vscode extension api');
		assert.strictEqual(response.provider, 'tavily');
		assert.strictEqual(response.results.length, 2);
		const first = response.results[0];
		assert.deepStrictEqual(first, {
			title: 'VS Code Extension API',
			url: 'https://code.visualstudio.com/api',
			snippet: 'Overview of the extension APIs.',
			score: 0.98,
			publishedAt: '2024-01-01T00:00:00.000000Z',
		});
		// 额外字段被丢弃
		assert.ok(!('raw_content' in first));
		assert.ok(!('images' in first));
		// 无 publishedAt 时该字段不存在
		const second = response.results[1];
		assert.ok(!('publishedAt' in second));
	});

	it('空域名列表不传 include_domains/exclude_domains', async () => {
		// Arrange
		const { calls, restore } = mockFetchJson(200, { results: [] });
		const provider = new TavilyWebSearchProvider();

		// Act
		await provider.search(makeRequest());

		// Assert
		restore();
		const body = JSON.parse(calls[0].init.body as string);
		assert.ok(!('include_domains' in body));
		assert.ok(!('exclude_domains' in body));
	});

	it('认证失败（401/403）：不可重试且错误不含 API Key', async () => {
		for (const status of [401, 403]) {
			const { restore } = mockFetchJson(status, { detail: 'invalid api key' });
			const provider = new TavilyWebSearchProvider();

			// Act / Assert
			await assert.rejects(
				provider.search(makeRequest()),
				(err) => {
					assert.ok(err instanceof WebSearchError);
					assert.strictEqual(err.retryable, false);
					assert.ok(!err.message.includes(API_KEY));
					return true;
				}
			);
			restore();
		}
	});

	it('限流（429）：可重试', async () => {
		// Arrange
		const { restore } = mockFetchJson(429, { detail: 'rate limit exceeded' });
		const provider = new TavilyWebSearchProvider();

		// Act / Assert
		await assert.rejects(
			provider.search(makeRequest()),
			(err) => {
				assert.ok(err instanceof WebSearchError);
				assert.strictEqual(err.retryable, true);
				assert.ok(!err.message.includes(API_KEY));
				return true;
			}
		);
		restore();
	});

	it('服务端错误（5xx）：可重试', async () => {
		// Arrange
		const { restore } = mockFetchJson(500, {});
		const provider = new TavilyWebSearchProvider();

		// Act / Assert
		await assert.rejects(
			provider.search(makeRequest()),
			(err) => {
				assert.ok(err instanceof WebSearchError);
				assert.strictEqual(err.retryable, true);
				return true;
			}
		);
		restore();
	});

	it('超时：abort 触发后可重试', async () => {
		// Arrange
		const restore = mockFetchHang();
		const provider = new TavilyWebSearchProvider();

		// Act / Assert（超时 30ms）
		await assert.rejects(
			provider.search(makeRequest({ timeoutMs: 30 })),
			(err) => {
				assert.ok(err instanceof WebSearchError);
				assert.strictEqual(err.retryable, true);
				assert.ok(err.message.includes('超时'));
				assert.ok(!err.message.includes(API_KEY));
				return true;
			}
		);
		restore();
	});

	it('网络失败：可重试且错误不含 API Key', async () => {
		// Arrange
		const restore = mockFetchThrow(new TypeError('fetch failed'));
		const provider = new TavilyWebSearchProvider();

		// Act / Assert
		await assert.rejects(
			provider.search(makeRequest()),
			(err) => {
				assert.ok(err instanceof WebSearchError);
				assert.strictEqual(err.retryable, true);
				assert.ok(!err.message.includes(API_KEY));
				return true;
			}
		);
		restore();
	});

	it('无效响应：缺 results 数组不可重试', async () => {
		// Arrange
		const { restore } = mockFetchJson(200, { foo: 'bar' });
		const provider = new TavilyWebSearchProvider();

		// Act / Assert
		await assert.rejects(
			provider.search(makeRequest()),
			(err) => {
				assert.ok(err instanceof WebSearchError);
				assert.strictEqual(err.retryable, false);
				return true;
			}
		);
		restore();
	});

	it('无效响应：JSON 解析失败不可重试', async () => {
		// Arrange
		const restore = mockFetchInvalidJson(200);
		const provider = new TavilyWebSearchProvider();

		// Act / Assert
		await assert.rejects(
			provider.search(makeRequest()),
			(err) => {
				assert.ok(err instanceof WebSearchError);
				assert.strictEqual(err.retryable, false);
				assert.ok(!err.message.includes(API_KEY));
				return true;
			}
		);
		restore();
	});

	it('结果条目缺 title/url 时被丢弃', async () => {
		// Arrange
		const { restore } = mockFetchJson(200, {
			results: [
				{ title: 'ok', url: 'https://ok.example.com', content: 'fine' },
				{ title: 'no url' },
				{ url: 'https://no-title.example.com' },
				'not-an-object',
				null,
			],
		});
		const provider = new TavilyWebSearchProvider();

		// Act
		const response = await provider.search(makeRequest());

		// Assert
		restore();
		assert.strictEqual(response.results.length, 1);
		assert.strictEqual(response.results[0].url, 'https://ok.example.com');
	});
});
