import * as assert from 'assert';
import { WebSearchTool } from '../../../tools/web/webSearch';
import type { ToolExecutionResult } from '../../../tools/baseTool';
import type { ToolContext } from '../../../tools/baseTool';
import type { WebSearchConfig } from '../../../config/webSearchConfig';
import {
	WEB_SEARCH_UNAVAILABLE_MESSAGE,
	WebSearchError,
	type WebSearchProvider,
	type WebSearchRequest,
	type WebSearchResponse,
} from '../../../tools/web/types';
import { ToolRegistry } from '../../../core/toolRegistry';
import { InvalidArgumentsError, ToolValidationError } from '../../../core/errors';

/** 测试用配置（已启用 + 有 API Key）。 */
const ENABLED_CONFIG: WebSearchConfig = {
	enabled: true,
	apiKey: 'tvly-test-key',
	maxResults: 5,
	searchDepth: 'basic',
	timeoutMs: 5_000,
	includeDomains: [],
	excludeDomains: [],
};

/** 可记录请求并可注入错误的 mock Provider。 */
class MockProvider implements WebSearchProvider {
	readonly requests: WebSearchRequest[] = [];
	private readonly response: WebSearchResponse;
	error?: WebSearchError;

	constructor(response?: WebSearchResponse) {
		this.response = response ?? { query: 'test', provider: 'tavily', results: [] };
	}

	async search(request: WebSearchRequest): Promise<WebSearchResponse> {
		this.requests.push(request);
		if (this.error) {
			throw this.error;
		}
		return this.response;
	}
}

/** 构造已装配 mock 的工具。 */
function makeTool(opts: { config?: WebSearchConfig; provider?: MockProvider } = {}): {
	tool: WebSearchTool;
	provider: MockProvider;
} {
	const provider = opts.provider ?? new MockProvider();
	const config = opts.config ?? ENABLED_CONFIG;
	const tool = new WebSearchTool({ provider, configReader: () => config });
	return { tool, provider };
}

describe('WebSearchTool', () => {
	it('schema 声明只读权限与可并行', () => {
		// Arrange / Act
		const { tool } = makeTool();
		// Assert
		assert.strictEqual(tool.schema.permissions, 'read');
		assert.strictEqual(tool.schema.canParallel, true);
	});

	it('validate 拒绝缺失与空白 query', () => {
		// Arrange
		const { tool } = makeTool();
		// Act / Assert
		assert.throws(() => tool.validate({}), ToolValidationError);
		assert.throws(() => tool.validate({ query: '   ' }), ToolValidationError);
		assert.doesNotThrow(() => tool.validate({ query: 'typescript' }));
	});

	it('schema 校验拒绝越界 maxResults、非法 searchDepth 与未声明参数', () => {
		// Arrange
		const { tool } = makeTool();
		const registry = new ToolRegistry();
		registry.register(tool);
		// Act / Assert
		assert.throws(() => registry.validateArgs('web.search', { query: 'x', maxResults: 0 }), InvalidArgumentsError);
		assert.throws(() => registry.validateArgs('web.search', { query: 'x', maxResults: 11 }), InvalidArgumentsError);
		assert.throws(() => registry.validateArgs('web.search', { query: 'x', searchDepth: 'deep' }), InvalidArgumentsError);
		assert.throws(() => registry.validateArgs('web.search', { query: 'x', unknown: 1 }), InvalidArgumentsError);
	});

	it('未启用时不发起网络请求，返回不可用错误且不可重试', async () => {
		// Arrange
		const { tool, provider } = makeTool({
			config: { ...ENABLED_CONFIG, enabled: false },
		});
		// Act
		const result = await tool.execute({ query: 'hello' }, {} as ToolContext);
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, WEB_SEARCH_UNAVAILABLE_MESSAGE);
		assert.strictEqual(result.metadata?.retryable, false);
		assert.strictEqual(provider.requests.length, 0);
	});

	it('已启用但缺 API Key 时不发起网络请求，返回不可用错误', async () => {
		// Arrange
		const { tool, provider } = makeTool({
			config: { ...ENABLED_CONFIG, apiKey: '' },
		});
		// Act
		const result = await tool.execute({ query: 'hello' }, {} as ToolContext);
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('webSearch 不可用'));
		assert.strictEqual(result.metadata?.retryable, false);
		assert.strictEqual(provider.requests.length, 0);
	});

	it('启用且有 Key 时装配默认参数发起请求并返回成功结果', async () => {
		// Arrange
		const response: WebSearchResponse = {
			query: 'vscode api',
			provider: 'tavily',
			results: [{ title: 'VS Code API', url: 'https://code.visualstudio.com/api', snippet: 'docs' }],
		};
		const { tool, provider } = makeTool({ provider: new MockProvider(response) });
		// Act
		const result = await tool.execute({ query: '  vscode api  ' }, { sessionId: 's1' } as ToolContext);
		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.query, 'vscode api');
		assert.strictEqual(payload.provider, 'tavily');
		assert.strictEqual(payload.results.length, 1);
		assert.strictEqual(payload.results[0].url, 'https://code.visualstudio.com/api');
		assert.ok(typeof result.metadata?.duration_ms === 'number');
		// 请求参数：query trim、默认值来自配置
		const request = provider.requests[0];
		assert.strictEqual(request.query, 'vscode api');
		assert.strictEqual(request.maxResults, 5);
		assert.strictEqual(request.searchDepth, 'basic');
		assert.strictEqual(request.timeoutMs, 5_000);
		assert.deepStrictEqual(request.includeDomains, []);
		assert.strictEqual(request.apiKey, 'tvly-test-key');
	});

	it('maxResults 越界时约束到 1-10', async () => {
		// Arrange
		const { tool, provider } = makeTool();
		// Act
		await tool.execute({ query: 'x', maxResults: 0 }, {} as ToolContext);
		assert.strictEqual(provider.requests[0].maxResults, 1);
		await tool.execute({ query: 'x', maxResults: 100 }, {} as ToolContext);
		assert.strictEqual(provider.requests[1].maxResults, 10);
	});

	it('调用参数覆盖配置默认值', async () => {
		// Arrange
		const { tool, provider } = makeTool({
			config: { ...ENABLED_CONFIG, includeDomains: ['a.com'], excludeDomains: ['b.com'] },
		});
		// Act
		await tool.execute(
			{
				query: 'x',
				maxResults: 7,
				searchDepth: 'advanced',
				includeDomains: ['c.com'],
				excludeDomains: ['d.com'],
			},
			{} as ToolContext
		);
		// Assert
		const request = provider.requests[0];
		assert.strictEqual(request.maxResults, 7);
		assert.strictEqual(request.searchDepth, 'advanced');
		assert.deepStrictEqual(request.includeDomains, ['c.com']);
		assert.deepStrictEqual(request.excludeDomains, ['d.com']);
	});

	it('Provider 抛出 WebSearchError 时转为结构化错误并保留 retryable', async () => {
		// Arrange
		const provider = new MockProvider();
		provider.error = new WebSearchError('Tavily 请求过于频繁（限流），请稍后重试', true);
		const { tool } = makeTool({ provider });
		// Act
		const result = await tool.execute({ query: 'x' }, {} as ToolContext);
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('限流'));
		assert.strictEqual(result.metadata?.retryable, true);
	});

	it('Provider 抛不可重试错误时 retryable=false', async () => {
		// Arrange
		const provider = new MockProvider();
		provider.error = new WebSearchError('Tavily 认证失败：请检查 yunxiaoAgent.webSearch.apiKey', false);
		const { tool } = makeTool({ provider });
		// Act
		const result = await tool.execute({ query: 'x' }, {} as ToolContext);
		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('认证失败'));
		assert.ok(!result.error?.includes('tvly-test-key'));
		assert.strictEqual(result.metadata?.retryable, false);
	});

	it('结果经过统一治理：超长结果被截断并标注', async () => {
		// Arrange
		const { tool } = makeTool();
		const raw: ToolExecutionResult = { status: 'success', result: 'x'.repeat(5_000) };
		// Act
		const governed = tool.governResult(raw, {
			workspaceRoots: [],
			governMaxBytes: 100,
		} as ToolContext);
		// Assert
		assert.strictEqual(governed.metadata?.truncated, true);
		assert.ok((governed.result?.length ?? 0) < 5_000);
	});
});
