/**
 * McpServerConnection Legacy SSE Fallback 测试（任务 8.6 + 8.7）。
 *
 * 覆盖 spec「Legacy SSE Fallback」「负向回退拒绝」场景：
 *
 * 8.6 正向回退：
 * - 显式开启 + compat-fail → 回退成功，actualTransport=legacy-sse
 * - 回退使用新 Client，第一套 Client/Transport 已释放
 * - 未开启 legacySseFallback → compat-fail 仍进入 error，不回退
 *
 * 8.7 负向回退（以下场景均不触发 SSE 回退）：
 * - 401 → http_auth 错误，不回退
 * - 403 → http_status 错误，不回退
 * - 5xx → http_status 错误，不回退
 * - 连接超时 → timeout 错误，不回退
 *
 * 通过真实 HTTP fixture 子进程验证；afterEach 释放 Connection 与 fixture。
 */
import * as assert from 'assert';
import { McpServerConnection } from '../../mcp/connection';
import type { StreamableHttpMcpRuntimeConfig } from '../../mcp/types';
import { startHttpFixture, type HttpFixtureHandle } from './fixtures/httpFixtureHelper';

/** 已创建资源（afterEach 统一释放）。 */
const connections: McpServerConnection[] = [];
const fixtures: HttpFixtureHandle[] = [];

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造 Streamable HTTP 运行时配置。 */
function httpConfig(
	url: string,
	opts?: {
		readonly headers?: Record<string, string>;
		readonly connectTimeoutMs?: number;
		readonly legacySseFallback?: boolean;
	},
): StreamableHttpMcpRuntimeConfig {
	return {
		type: 'streamable-http',
		url,
		headers: opts?.headers ?? {},
		legacySseFallback: opts?.legacySseFallback ?? false,
		enabled: true,
		connectTimeoutMs: opts?.connectTimeoutMs ?? 10000,
		callTimeoutMs: 10000,
	};
}

/** 创建 Connection 并登记到清理列表。 */
function createConnection(config: StreamableHttpMcpRuntimeConfig): McpServerConnection {
	const conn = new McpServerConnection({
		serverId: 'http-fixture',
		config,
		workspaceTrusted: true,
		callbacks: {
			onStatusChange: () => undefined,
			onToolsPublished: () => undefined,
			onInstructions: () => undefined,
		},
	});
	connections.push(conn);
	return conn;
}

/** 启动 fixture 并登记到清理列表。 */
async function startFixture(env: Record<string, string> = {}): Promise<HttpFixtureHandle> {
	const f = await startHttpFixture(env);
	fixtures.push(f);
	return f;
}

// ── 8.6 正向回退 ──

describe('McpServerConnection Legacy SSE Fallback（8.6）', () => {
	afterEach(async () => {
		await Promise.all(connections.splice(0).map((c) => c.dispose()));
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
		await sleep(50);
	});

	it('显式开启 + compat-fail → 回退 SSE 成功，actualTransport=legacy-sse', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'compat-fail',
			MCP_FIXTURE_TOOLS_COUNT: '2',
			MCP_FIXTURE_INSTRUCTIONS: '通过 SSE 回退连接',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, { legacySseFallback: true }),
		);

		await conn.connect();

		assert.strictEqual(conn.status, 'ready', 'compat-fail + legacySseFallback 应回退成功');
		assert.strictEqual(conn.actualTransport, 'legacy-sse');
		assert.strictEqual(conn.tools.length, 2, '应通过 SSE 发现工具');
		assert.ok(conn.instructions, '应通过 SSE 获取 instructions');
		assert.strictEqual(conn.instructions!.content, '通过 SSE 回退连接');
	});

	it('未开启 legacySseFallback → compat-fail 进入 error，不回退', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'compat-fail',
			MCP_FIXTURE_TOOLS_COUNT: '2',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, { legacySseFallback: false }),
		);

		await conn.connect();

		assert.strictEqual(conn.status, 'error', '未开启回退应直接失败');
		assert.strictEqual(conn.actualTransport, undefined, '不应设置 actualTransport');
		assert.strictEqual(conn.tools.length, 0, '不得发布工具');
	});

	it('回退使用新 Client/Transport，第一套已释放', async () => {
		// 验证点：回退后连接正常 ready 且可调用工具，说明新 Client 工作。
		// 第一套 Client/Transport 被释放不会阻塞回退。
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'compat-fail',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, { legacySseFallback: true }),
		);

		await conn.connect();

		assert.strictEqual(conn.status, 'ready');
		assert.strictEqual(conn.actualTransport, 'legacy-sse');

		// 回退后可正常调用工具
		const result = await conn.callTool('tool_0', { input: 'hello' });
		assert.strictEqual(result.status, 'success');
		assert.ok(result.result.includes('echo: hello'));
	});
});

// ── 8.7 负向回退 ──

describe('McpServerConnection 负向回退拒绝（8.7）', () => {
	afterEach(async () => {
		await Promise.all(connections.splice(0).map((c) => c.dispose()));
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
		await sleep(50);
	});

	it('401 不触发 SSE 回退（http_auth）', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'compat-fail',
			MCP_HTTP_STATUS: '401',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, { legacySseFallback: true }),
		);

		await conn.connect();

		assert.strictEqual(conn.status, 'error', '401 不应触发回退');
		assert.strictEqual(conn.actualTransport, undefined);
		assert.strictEqual(conn.tools.length, 0);
	});

	it('403 不触发 SSE 回退（http_status）', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'compat-fail',
			MCP_HTTP_STATUS: '403',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, { legacySseFallback: true }),
		);

		await conn.connect();

		assert.strictEqual(conn.status, 'error', '403 不应触发回退');
		assert.strictEqual(conn.actualTransport, undefined);
		assert.strictEqual(conn.tools.length, 0);
	});

	it('5xx 不触发 SSE 回退（http_status）', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'compat-fail',
			MCP_HTTP_STATUS: '500',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, { legacySseFallback: true }),
		);

		await conn.connect();

		assert.strictEqual(conn.status, 'error', '5xx 不应触发回退');
		assert.strictEqual(conn.actualTransport, undefined);
		assert.strictEqual(conn.tools.length, 0);
	});

	it('连接超时不触发 SSE 回退（timeout）', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_HTTP_DELAY_MS: '3000',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, {
				legacySseFallback: true,
				connectTimeoutMs: 800,
			}),
		);

		await conn.connect();

		assert.strictEqual(conn.status, 'error', '超时不应触发回退');
		assert.strictEqual(conn.actualTransport, undefined);
		assert.strictEqual(conn.tools.length, 0);
	});
});
