/**
 * McpServerConnection Streamable HTTP 连接测试（任务 8.2）。
 *
 * 覆盖 spec「Streamable HTTP Transport 生命周期」「MCP 初始化与 Server 元数据」场景：
 * - loopback HTTP 连接就绪并发布工具与 instructions（Server 元数据）
 * - 同 origin headers：SecretStorage 装配的 header 到达 Server
 * - 跨 origin redirect 拒绝：Server 302 到不同 origin 时连接失败
 * - 连接超时：Server 延迟响应超过 connectTimeoutMs 时进入 error(timeout)
 *
 * 通过真实 HTTP fixture 子进程（out/test/mcp/fixtures/httpServer.js）验证；
 * afterEach 释放 Connection 与 fixture 以避免悬挂进程。
 */
import * as assert from 'assert';
import { McpServerConnection, type McpConnectionCallbacks } from '../../mcp/connection';
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
function httpConfig(url: string, opts?: { readonly headers?: Record<string, string>; readonly connectTimeoutMs?: number; readonly legacySseFallback?: boolean }): StreamableHttpMcpRuntimeConfig {
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

describe('McpServerConnection Streamable HTTP 连接（8.2）', () => {
	afterEach(async () => {
		await Promise.all(connections.splice(0).map((c) => c.dispose()));
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
		await sleep(50);
	});

	it('loopback HTTP：连接就绪并发布工具与 instructions（Server 元数据）', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '3',
			MCP_FIXTURE_INSTRUCTIONS: '使用远程工具查询',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`));

		await conn.connect();

		assert.strictEqual(conn.status, 'ready');
		assert.strictEqual(conn.actualTransport, 'streamable-http');
		assert.strictEqual(conn.tools.length, 3);
		assert.ok(conn.instructions);
		assert.strictEqual(conn.instructions!.content, '使用远程工具查询');
	});

	it('同 origin headers：SecretStorage 装配的 header 到达 Server', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_HTTP_INSPECT_HEADERS: '1',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`, { headers: { Authorization: 'Bearer test-token-123' } }));

		await conn.connect();

		assert.strictEqual(conn.status, 'ready');
		// fixture 把 Authorization 写入 stderr
		const tail = fixture.stderrTail();
		assert.ok(tail.includes('Bearer test-token-123'), `Server 应收到 Authorization header，stderr: ${tail}`);
	});

	it('跨 origin redirect 拒绝：Server 302 到不同 origin 时连接失败', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_HTTP_REDIRECT_ORIGIN: 'http://evil.example.com',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`));

		await conn.connect();

		assert.strictEqual(conn.status, 'error');
		assert.strictEqual(conn.tools.length, 0, '不得发布工具');
	});

	it('连接超时：Server 延迟响应超过 connectTimeoutMs 时进入 error', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_HTTP_DELAY_MS: '3000',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`, { connectTimeoutMs: 800 }));

		await conn.connect();

		assert.strictEqual(conn.status, 'error');
		assert.strictEqual(conn.tools.length, 0);
	});
});
