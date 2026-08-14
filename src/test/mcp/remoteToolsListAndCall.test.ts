/**
 * McpServerConnection 远程 tools/list 与 tools/call 测试（任务 8.9）。
 *
 * 覆盖 spec「远程工具发现与调用」场景：
 * - 分页发现：HTTP tools/list 分多页返回，完整列表后发布一次
 * - list_changed：通知触发重新发现并原子替换
 * - 并发不串线：两个并发调用各自回显
 * - 取消：AbortSignal 返回 cancelled，连接仍可用
 * - 超时：超过 callTimeoutMs 返回 error，不自动重放
 * - exactly-once：超时后 Server 端只被调用一次
 *
 * 通过真实 HTTP fixture 子进程验证；afterEach 释放 Connection 与 fixture。
 */
import * as assert from 'assert';
import { McpServerConnection, type McpConnectionCallbacks } from '../../mcp/connection';
import type {
	McpDiscoveredTool,
	McpError as McpFailure,
	McpServerInstructions,
	McpServerStatus,
	StreamableHttpMcpRuntimeConfig,
} from '../../mcp/types';
import { startHttpFixture, type HttpFixtureHandle } from './fixtures/httpFixtureHelper';

/** 已创建资源（afterEach 统一释放）。 */
const connections: McpServerConnection[] = [];
const fixtures: HttpFixtureHandle[] = [];

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到条件满足或超时。 */
async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, intervalMs = 30): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = fn();
		if (v !== undefined) {
			return v;
		}
		if (Date.now() >= deadline) {
			throw new Error(`waitFor 超时（${timeoutMs}ms）`);
		}
		await sleep(intervalMs);
	}
}

/** 构造 Streamable HTTP 运行时配置。 */
function httpConfig(url: string, opts?: { readonly callTimeoutMs?: number; readonly connectTimeoutMs?: number }): StreamableHttpMcpRuntimeConfig {
	return {
		type: 'streamable-http',
		url,
		headers: {},
		legacySseFallback: false,
		enabled: true,
		connectTimeoutMs: opts?.connectTimeoutMs ?? 10000,
		callTimeoutMs: opts?.callTimeoutMs ?? 10000,
	};
}

/** 记录连接事件的录制器。 */
interface Recorder {
	readonly callbacks: McpConnectionCallbacks;
	readonly statuses: { readonly status: McpServerStatus; readonly error?: McpFailure }[];
	readonly toolSnapshots: readonly McpDiscoveredTool[][];
	readonly instructionsLog: (McpServerInstructions | undefined)[];
}

/** 创建事件录制器。 */
function createRecorder(): Recorder {
	const statuses: { status: McpServerStatus; error?: McpFailure }[] = [];
	const toolSnapshots: McpDiscoveredTool[][] = [];
	const instructionsLog: (McpServerInstructions | undefined)[] = [];
	const callbacks: McpConnectionCallbacks = {
		onStatusChange: (_id, status, error) => statuses.push({ status, error }),
		onToolsPublished: (_id, tools) => toolSnapshots.push([...tools]),
		onInstructions: (_id, instr) => instructionsLog.push(instr),
	};
	return { callbacks, statuses, toolSnapshots, instructionsLog };
}

/** 创建 Connection 并登记到清理列表。 */
function createConnection(config: StreamableHttpMcpRuntimeConfig, recorder?: Recorder): McpServerConnection {
	const conn = new McpServerConnection({
		serverId: 'http-fixture',
		config,
		workspaceTrusted: true,
		callbacks: recorder?.callbacks ?? {
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

/** 统计 stderr 中 fixture_call 计数标记数量。 */
function countFixtureCalls(fixture: HttpFixtureHandle): number {
	const tail = fixture.stderrTail();
	return (tail.match(/fixture_call:\d+/g) ?? []).length;
}

// ── 远程 tools/list ──

describe('McpServerConnection 远程 tools/list（8.9）', () => {
	afterEach(async () => {
		await Promise.all(connections.splice(0).map((c) => c.dispose()));
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
		await sleep(50);
	});

	it('分页发现：HTTP tools/list 分多页返回，只在完整列表后发布一次', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '5',
			MCP_FIXTURE_PAGE_SIZE: '2',
		});
		const recorder = createRecorder();
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`), recorder);

		await conn.connect();

		assert.strictEqual(conn.status, 'ready');
		assert.strictEqual(conn.tools.length, 5, '应发现全部 5 个工具');
		assert.strictEqual(recorder.toolSnapshots.length, 1, '不应发布半量快照');
		const names = recorder.toolSnapshots[0].map((t) => t.nativeToolName);
		assert.deepStrictEqual(names, ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4']);
	});

	it('list_changed：通知触发重新发现并原子替换', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '2',
			MCP_FIXTURE_LIST_CHANGED: '1',
			MCP_FIXTURE_LIST_CHANGED_DELAY_MS: '200',
			MCP_FIXTURE_LIST_CHANGED_TOOLS_COUNT: '4',
		});
		const recorder = createRecorder();
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`), recorder);

		await conn.connect();
		assert.strictEqual(conn.tools.length, 2, '初始应发现 2 个工具');
		assert.strictEqual(recorder.toolSnapshots.length, 1, '初始发布一次');

		await waitFor(() => (recorder.toolSnapshots.length >= 2 ? true : undefined), 3000);

		assert.strictEqual(conn.status, 'ready', '重新发现后应仍为 ready');
		assert.strictEqual(recorder.toolSnapshots.length, 2, '应发布第二次完整快照');
		assert.strictEqual(recorder.toolSnapshots[1].length, 4, '新快照应为 4 个工具');
		assert.strictEqual(conn.tools.length, 4);
	});
});

// ── 远程 tools/call ──

describe('McpServerConnection 远程 tools/call（8.9）', () => {
	afterEach(async () => {
		await Promise.all(connections.splice(0).map((c) => c.dispose()));
		await Promise.all(fixtures.splice(0).map((f) => f.close()));
		await sleep(50);
	});

	it('原始名称/参数：用原始工具名与 arguments 调用，echo 原样回显', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`));
		await conn.connect();
		assert.strictEqual(conn.status, 'ready');

		const result = await conn.callTool('tool_0', { input: 'hello-remote' });

		assert.strictEqual(result.status, 'success');
		assert.strictEqual(result.result, 'echo: hello-remote');
	});

	it('并发不串线：两个并发调用各自回显自己的入参', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_FIXTURE_CALL_DELAY_MS: '120',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`));
		await conn.connect();
		assert.strictEqual(conn.status, 'ready');

		const [a, b] = await Promise.all([
			conn.callTool('tool_0', { input: 'AAA' }),
			conn.callTool('tool_0', { input: 'BBB' }),
		]);

		assert.strictEqual(a.status, 'success');
		assert.strictEqual(b.status, 'success');
		const texts = new Set([a.result, b.result]);
		assert.ok(texts.has('echo: AAA'), `应包含 AAA 回显，实际 a=${a.result} b=${b.result}`);
		assert.ok(texts.has('echo: BBB'), `应包含 BBB 回显，实际 a=${a.result} b=${b.result}`);
		assert.notStrictEqual(a.result, b.result, '两个并发调用结果不应相同');
	});

	it('取消：AbortSignal 触发返回 cancelled，连接仍可用', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_FIXTURE_CALL_DELAY_MS: '500',
		});
		const conn = createConnection(httpConfig(`${fixture.baseUrl}/mcp`));
		await conn.connect();
		assert.strictEqual(conn.status, 'ready');

		const controller = new AbortController();
		const pending = conn.callTool('tool_0', { input: 'cancel-me' }, controller.signal);
		setTimeout(() => controller.abort(), 60);
		const result = await pending;

		assert.strictEqual(result.status, 'cancelled', '取消应返回 cancelled');
		assert.strictEqual(conn.status, 'ready');
		const fresh = await conn.callTool('tool_0', { input: 'after-cancel' });
		assert.strictEqual(fresh.status, 'success');
		assert.strictEqual(fresh.result, 'echo: after-cancel');
	});

	it('超时：超过 callTimeoutMs 返回结构化 error，不自动重放', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_FIXTURE_CALL_DELAY_MS: '800',
			MCP_FIXTURE_COUNT_CALLS: '1',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, { callTimeoutMs: 250 }),
		);
		await conn.connect();
		assert.strictEqual(conn.status, 'ready');

		const result = await conn.callTool('tool_0', { input: 'slow' });

		assert.strictEqual(result.status, 'error', '超时应返回 error');
		assert.ok(result.result.includes('超时'), `结果应提示超时，实际：${result.result}`);
		assert.strictEqual(conn.status, 'ready');
	});

	it('exactly-once：超时后 Server 端只被调用一次（无重放）', async () => {
		const fixture = await startFixture({
			MCP_HTTP_MODE: 'streamable',
			MCP_FIXTURE_TOOLS_COUNT: '1',
			MCP_FIXTURE_CALL_DELAY_MS: '800',
			MCP_FIXTURE_COUNT_CALLS: '1',
		});
		const conn = createConnection(
			httpConfig(`${fixture.baseUrl}/mcp`, { callTimeoutMs: 250 }),
		);
		await conn.connect();
		assert.strictEqual(conn.status, 'ready');

		await conn.callTool('tool_0', { input: 'once' });

		await sleep(50);
		assert.strictEqual(countFixtureCalls(fixture), 1, '超时不应触发重放，Server 端只被调用一次');
	});
});
