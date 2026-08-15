/**
 * McpServerConnection STDIO tools/call 测试（任务 7.6）。
 *
 * 覆盖 spec「MCP tools/call」「调用取消与超时」场景：
 * - 原始名称/参数：Bridge 用原始工具名与本地校验后的 arguments 调用，echo 原样回显
 * - 并发不串线：两个并发调用各自回显自己的入参，不发生串线
 * - isError：Server 返回 isError=true → 归一化为 error 状态且 metadata.isError
 * - 取消：AbortSignal 触发 → 返回 cancelled，迟到结果被忽略，连接仍可用
 * - 超时：超过 callTimeoutMs → 返回结构化 error，不自动重放
 * - exactly-once：超时/取消后 Server 端只被调用一次（无重放）
 *
 * 通过真实 fixture 子进程（out/test/mcp/fixtures/stdioServer.js）验证；
 * afterEach 释放 Connection 以避免悬挂子进程。
 */
import * as assert from 'assert';
import * as path from 'path';
import { McpServerConnection, type McpConnectionCallbacks } from '../../mcp/connection';
import type {
	McpDiscoveredTool,
	McpError as McpFailure,
	McpServerInstructions,
	McpServerStatus,
	StdioMcpRuntimeConfig,
} from '../../mcp/types';

/** 编译后 fixture 路径（out/test/mcp/fixtures/stdioServer.js）。 */
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'stdioServer.js');

/** 已创建 Connection 列表（afterEach 统一释放）。 */
const created: McpServerConnection[] = [];

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造 STDIO 运行时配置。 */
function stdioConfig(env: Record<string, string> = {}, opts?: { readonly callTimeoutMs?: number }): StdioMcpRuntimeConfig {
	return {
		type: 'stdio',
		command: 'node',
		args: [FIXTURE_PATH],
		env,
		enabled: true,
		connectTimeoutMs: 10000,
		callTimeoutMs: opts?.callTimeoutMs ?? 10000,
	};
}

/** 创建并连接一个就绪 Connection。 */
async function readyConnection(env: Record<string, string> = {}, opts?: { readonly callTimeoutMs?: number }): Promise<McpServerConnection> {
	const conn = new McpServerConnection({
		serverId: 'fixture',
		config: stdioConfig(env, opts),
		workspaceTrusted: true,
		callbacks: {
			onStatusChange: () => undefined,
			onToolsPublished: () => undefined,
			onInstructions: () => undefined,
		},
	});
	created.push(conn);
	await conn.connect();
	assert.strictEqual(conn.status, 'ready', '前置：Connection 应就绪');
	return conn;
}

/** 统计 stderr 中 fixture_call 计数标记数量（exactly-once 验证）。 */
function countFixtureCalls(conn: McpServerConnection): number {
	const tail = conn.stderrTail ?? '';
	return (tail.match(/fixture_call:\d+/g) ?? []).length;
}

describe('McpServerConnection STDIO tools/call（7.6）', () => {
	afterEach(async () => {
		const conns = created.splice(0);
		await Promise.all(conns.map((c) => c.dispose()));
		await sleep(50);
	});

	it('原始名称/参数：用原始工具名与 arguments 调用，echo 原样回显', async () => {
		const conn = await readyConnection({ MCP_FIXTURE_TOOLS_COUNT: '1' });

		const result = await conn.callTool('tool_0', { input: 'hello-world' });

		assert.strictEqual(result.status, 'success');
		assert.strictEqual(result.result, 'echo: hello-world');
	});

	it('并发不串线：两个并发调用各自回显自己的入参', async () => {
		const conn = await readyConnection({ MCP_FIXTURE_TOOLS_COUNT: '1', MCP_FIXTURE_CALL_DELAY_MS: '120' });

		const [a, b] = await Promise.all([
			conn.callTool('tool_0', { input: 'AAA' }),
			conn.callTool('tool_0', { input: 'BBB' }),
		]);

		assert.strictEqual(a.status, 'success');
		assert.strictEqual(b.status, 'success');
		// 各自回显自己的入参，不串线
		const texts = new Set([a.result, b.result]);
		assert.ok(texts.has('echo: AAA'), `应包含 AAA 回显，实际 a=${a.result} b=${b.result}`);
		assert.ok(texts.has('echo: BBB'), `应包含 BBB 回显，实际 a=${a.result} b=${b.result}`);
		assert.notStrictEqual(a.result, b.result, '两个并发调用结果不应相同');
	});

	it('isError：Server 返回 isError=true → 归一化为 error 状态且 metadata.isError', async () => {
		const conn = await readyConnection({ MCP_FIXTURE_TOOLS_COUNT: '1', MCP_FIXTURE_TOOL_ERROR: 'tool_0' });

		const result = await conn.callTool('tool_0', { input: 'x' });

		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.metadata.isError, true);
	});

	it('取消：AbortSignal 触发返回 cancelled，迟到结果被忽略且连接仍可用', async () => {
		const conn = await readyConnection(
			{ MCP_FIXTURE_TOOLS_COUNT: '1', MCP_FIXTURE_CALL_DELAY_MS: '500', MCP_FIXTURE_COUNT_CALLS: '1' },
		);

		const controller = new AbortController();
		const pending = conn.callTool('tool_0', { input: 'cancel-me' }, controller.signal);
		// 延迟后触发取消（fixture 需 500ms 才完成）
		setTimeout(() => controller.abort(), 60);
		const result = await pending;

		assert.strictEqual(result.status, 'cancelled', '取消应返回 cancelled');
		// 迟到结果被忽略：取消后连接仍 ready，且新调用返回正确回显而非被取消的迟到结果
		assert.strictEqual(conn.status, 'ready');
		const fresh = await conn.callTool('tool_0', { input: 'after-cancel' });
		assert.strictEqual(fresh.status, 'success');
		assert.strictEqual(fresh.result, 'echo: after-cancel');
	});

	it('超时：超过 callTimeoutMs 返回结构化 error，不自动重放', async () => {
		const conn = await readyConnection(
			{ MCP_FIXTURE_TOOLS_COUNT: '1', MCP_FIXTURE_CALL_DELAY_MS: '800', MCP_FIXTURE_COUNT_CALLS: '1' },
			{ callTimeoutMs: 250 },
		);

		const result = await conn.callTool('tool_0', { input: 'slow' });

		assert.strictEqual(result.status, 'error', '超时应返回 error');
		assert.ok(result.result.includes('超时'), `结果应提示超时，实际：${result.result}`);
		// 连接仍可用，超时不影响后续调用
		assert.strictEqual(conn.status, 'ready');
	});

	it('exactly-once：超时后 Server 端只被调用一次（无重放）', async () => {
		const conn = await readyConnection(
			{ MCP_FIXTURE_TOOLS_COUNT: '1', MCP_FIXTURE_CALL_DELAY_MS: '800', MCP_FIXTURE_COUNT_CALLS: '1' },
			{ callTimeoutMs: 250 },
		);

		await conn.callTool('tool_0', { input: 'once' });

		// 等待一拍确保 stderr 计数标记已写入（fixture 在延迟前即写入）
		await sleep(50);
		assert.strictEqual(countFixtureCalls(conn), 1, '超时不应触发重放，Server 端只被调用一次');
	});
});
