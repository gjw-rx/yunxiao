/**
 * McpServerConnection Streamable HTTP stateful/stateless 关闭测试（任务 8.4）。
 *
 * 覆盖 spec「Streamable HTTP Transport 生命周期」「Stateful session 关闭」场景：
 * - stateful：dispose 时存在 session → 先 terminateSession（DELETE），再关闭 Client
 * - stateless：dispose 时无 session → 直接关闭，不发送 DELETE
 *
 * 通过 fixture stderr 的 fixture_terminate:<sid> 标记验证 DELETE 是否被调用。
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
function httpConfig(url: string): StreamableHttpMcpRuntimeConfig {
	return {
		type: 'streamable-http',
		url,
		headers: {},
		legacySseFallback: false,
		enabled: true,
		connectTimeoutMs: 10000,
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

describe('McpServerConnection Streamable HTTP stateful/stateless 关闭（8.4）', () => {
	afterEach(async () => {
		await Promise.all(connections.splice(0).map((c) => c.dispose()));
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
		await sleep(50);
	});

	it('stateful：dispose 时存在 session → 先 terminateSession（DELETE），再关闭', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`));
		await conn.connect();
		assert.strictEqual(conn.status, 'ready');

		await conn.dispose();

		// fixture 应收到 DELETE 请求并写入 fixture_terminate 标记
		const tail = fixture.stderrTail();
		assert.ok(tail.includes('fixture_terminate:'), `stateful dispose 应触发 terminateSession，stderr: ${tail}`);
	});

	it('stateless：dispose 时无 session → 直接关闭，不发送 DELETE', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable-stateless',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`));
		await conn.connect();
		assert.strictEqual(conn.status, 'ready');

		await conn.dispose();

		// stateless 无 session，不应触发 DELETE
		const tail = fixture.stderrTail();
		assert.ok(!tail.includes('fixture_terminate:'), `stateless dispose 不应触发 terminateSession，stderr: ${tail}`);
	});
});
