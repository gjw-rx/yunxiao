/**
 * McpServerConnection STDIO dispose 测试（任务 7.8）。
 *
 * 覆盖 spec「STDIO Transport 生命周期」「扩展停用清理」场景：
 * - 停用/删除/扩展关闭：dispose 进入 stopping，下线工具/instructions，重复 dispose 幂等
 * - 请求取消：dispose 期间进行中调用被结束且 dispose 有界完成
 * - 正常退出：Server 自行以 0 退出后连接降级为 error(connection_closed) 且下线工具
 * - 强制有界清理：Transport close 挂起时 dispose 仍在有界时间内完成
 *
 * 通过真实 fixture 子进程（out/test/mcp/fixtures/stdioServer.js）验证；
 * afterEach 释放 Connection 以避免悬挂子进程。
 */
import * as assert from 'assert';
import * as path from 'path';
import { McpServerConnection, type McpConnectionCallbacks } from '../../mcp/connection';
import { createStdioTransport, type McpTransportHandle } from '../../mcp/transportFactory';
import type {
	McpDiscoveredTool,
	McpError as McpFailure,
	McpServerInstructions,
	McpServerRuntimeConfig,
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

/** 轮询直到条件满足或超时（毫秒）。 */
async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, intervalMs = 30): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (; ;) {
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

/** 构造 STDIO 运行时配置。 */
function stdioConfig(env: Record<string, string> = {}): StdioMcpRuntimeConfig {
	return {
		type: 'stdio',
		command: 'node',
		args: [FIXTURE_PATH],
		env,
		enabled: true,
		connectTimeoutMs: 10000,
		callTimeoutMs: 10000,
	};
}

/** 创建并连接一个就绪 Connection（带录制器）。 */
async function readyConnection(recorder: Recorder, env: Record<string, string> = {}): Promise<McpServerConnection> {
	const conn = new McpServerConnection({
		serverId: 'fixture',
		config: stdioConfig(env),
		workspaceTrusted: true,
		callbacks: recorder.callbacks,
	});
	created.push(conn);
	await conn.connect();
	assert.strictEqual(conn.status, 'ready', '前置：Connection 应就绪');
	return conn;
}

describe('McpServerConnection STDIO dispose（7.8）', () => {
	afterEach(async () => {
		const conns = created.splice(0);
		await Promise.all(conns.map((c) => c.dispose()));
		await sleep(50);
	});

	it('停用/删除/扩展关闭：dispose 进入 stopping，下线工具/instructions，重复 dispose 幂等', async () => {
		const recorder = createRecorder();
		const conn = await readyConnection(recorder, { MCP_FIXTURE_TOOLS_COUNT: '2', MCP_FIXTURE_INSTRUCTIONS: '使用说明' });
		const toolsBefore = recorder.toolSnapshots.length;
		const instrBefore = recorder.instructionsLog.length;
		assert.ok(conn.instructions, '前置：instructions 应已发布');

		await conn.dispose();

		assert.strictEqual(conn.status, 'stopping');
		// 工具下线：新增一次空列表发布
		assert.strictEqual(recorder.toolSnapshots.length, toolsBefore + 1);
		assert.strictEqual(recorder.toolSnapshots[recorder.toolSnapshots.length - 1].length, 0);
		// instructions 移除：新增一次 undefined
		assert.strictEqual(recorder.instructionsLog.length, instrBefore + 1);
		assert.strictEqual(recorder.instructionsLog[recorder.instructionsLog.length - 1], undefined);
		// 重复 dispose 幂等：不再产生新回调
		const statusesBefore = recorder.statuses.length;
		await conn.dispose();
		assert.strictEqual(recorder.statuses.length, statusesBefore, '重复 dispose 应幂等');
	});

	it('请求取消：dispose 期间进行中调用被结束且 dispose 有界完成', async () => {
		const recorder = createRecorder();
		const conn = await readyConnection(recorder, { MCP_FIXTURE_TOOLS_COUNT: '1', MCP_FIXTURE_CALL_DELAY_MS: '4000' });

		// 发起一个长耗时调用，随后立即 dispose
		const pending = conn.callTool('tool_0', { input: 'long-running' });
		const start = Date.now();
		await conn.dispose();
		const elapsed = Date.now() - start;
		// 进行中调用应被结束（client.close 拒绝 pending 请求），不悬挂
		const result = await pending;
		assert.ok(result.status === 'error' || result.status === 'cancelled', `进行中调用应被结束，实际 status=${result.status}`);
		// dispose 必须远小于 fixture 调用延迟（4000ms），证明未等待进行中调用；SDK 自身有 2s 子进程退出竞态
		assert.ok(elapsed < 3500, `dispose 应有界完成（不等待进行中调用），实际 ${elapsed}ms`);
	});

	it('正常退出：Server 自行以 0 退出后连接降级为 error(connection_closed) 且下线工具', async () => {
		const recorder = createRecorder();
		const conn = await readyConnection(recorder, { MCP_FIXTURE_TOOLS_COUNT: '2', MCP_FIXTURE_EXIT_AFTER_MS: '300' });
		const toolsBefore = recorder.toolSnapshots.length;

		// 等待 fixture 自行退出并触发连接关闭
		await waitFor(() => (conn.status === 'error' ? true : undefined), 3000);

		assert.strictEqual(conn.status, 'error');
		assert.strictEqual(conn.error?.category, 'connection_closed');
		// 工具下线：新增一次空列表发布
		assert.strictEqual(recorder.toolSnapshots.length, toolsBefore + 1);
		assert.strictEqual(recorder.toolSnapshots[recorder.toolSnapshots.length - 1].length, 0);
	});

	it('强制有界清理：Transport close 挂起时 dispose 仍在有界时间内完成', async () => {
		const recorder = createRecorder();
		// 注入挂起的 close：transport 用真实 STDIO（保证握手成功），close 永不 resolve
		const hangingFactory = (config: McpServerRuntimeConfig, workspaceCwd?: string): McpTransportHandle => {
			const real = createStdioTransport(config as StdioMcpRuntimeConfig, workspaceCwd);
			return {
				transport: real.transport,
				actualTransport: real.actualTransport,
				stderrTail: real.stderrTail,
				close: () => new Promise<void>(() => undefined),
			};
		};
		const conn = new McpServerConnection({
			serverId: 'fixture',
			config: stdioConfig({ MCP_FIXTURE_TOOLS_COUNT: '1' }),
			workspaceTrusted: true,
			transportFactory: hangingFactory,
			callbacks: recorder.callbacks,
		});
		created.push(conn);
		await conn.connect();
		assert.strictEqual(conn.status, 'ready');

		const start = Date.now();
		await conn.dispose();
		const elapsed = Date.now() - start;
		// DISPOSE_CLOSE_TIMEOUT_MS=3000，挂起的 close 必须被有界跳过
		assert.ok(elapsed < 4500, `挂起 close 时 dispose 应有界完成，实际 ${elapsed}ms`);
		assert.strictEqual(conn.status, 'stopping');
	});
});
