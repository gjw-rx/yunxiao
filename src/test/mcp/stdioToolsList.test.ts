/**
 * McpServerConnection STDIO tools/list 测试（任务 7.4）。
 *
 * 覆盖 spec「MCP 工具分页发现与变化」三场景：
 * - 分页发现：tools/list 分多页返回，只在完整列表后发布一次不可变快照
 * - 工具列表变化：list_changed 通知触发重新完整分页发现并原子替换
 * - 刷新失败：第二页发现失败不发布半量列表且进入 error
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

/** 已创建 Connection 列表（afterEach 统一释放）。 */
const created: McpServerConnection[] = [];

/** 创建 Connection 并登记到清理列表。 */
function createConnection(config: StdioMcpRuntimeConfig, recorder: Recorder): McpServerConnection {
	const conn = new McpServerConnection({
		serverId: 'fixture',
		config,
		workspaceTrusted: true,
		callbacks: recorder.callbacks,
	});
	created.push(conn);
	return conn;
}

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到条件满足或超时（毫秒）。 */
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

describe('McpServerConnection STDIO tools/list（7.4）', () => {
	afterEach(async () => {
		const conns = created.splice(0);
		await Promise.all(conns.map((c) => c.dispose()));
		await sleep(50);
	});

	it('分页发现：tools/list 分多页返回，只在完整列表后发布一次', async () => {
		const recorder = createRecorder();
		// 5 个工具、每页 2 个 → 3 次请求（2 + 2 + 1）
		const config = stdioConfig({ MCP_FIXTURE_TOOLS_COUNT: '5', MCP_FIXTURE_PAGE_SIZE: '2' });
		const conn = createConnection(config, recorder);

		await conn.connect();

		assert.strictEqual(conn.status, 'ready');
		assert.strictEqual(conn.tools.length, 5, '应发现全部 5 个工具');
		// 只在完整列表后发布一次
		assert.strictEqual(recorder.toolSnapshots.length, 1, '不应发布半量快照');
		assert.strictEqual(recorder.toolSnapshots[0].length, 5);
		const names = recorder.toolSnapshots[0].map((t) => t.nativeToolName);
		assert.deepStrictEqual(names, ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4']);
	});

	it('工具列表变化：list_changed 通知触发重新发现并原子替换', async () => {
		const recorder = createRecorder();
		// 初始 2 个工具，200ms 后发 list_changed 并把工具数重建为 4
		const config = stdioConfig({
			MCP_FIXTURE_TOOLS_COUNT: '2',
			MCP_FIXTURE_LIST_CHANGED: '1',
			MCP_FIXTURE_LIST_CHANGED_DELAY_MS: '200',
			MCP_FIXTURE_LIST_CHANGED_TOOLS_COUNT: '4',
		});
		const conn = createConnection(config, recorder);

		await conn.connect();
		assert.strictEqual(conn.tools.length, 2, '初始应发现 2 个工具');
		assert.strictEqual(recorder.toolSnapshots.length, 1, '初始发布一次');

		// 等待 list_changed 触发重新发现并发布第二次快照
		await waitFor(() => (recorder.toolSnapshots.length >= 2 ? true : undefined), 3000);

		assert.strictEqual(conn.status, 'ready', '重新发现后应仍为 ready');
		assert.strictEqual(recorder.toolSnapshots.length, 2, '应发布第二次完整快照');
		assert.strictEqual(recorder.toolSnapshots[1].length, 4, '新快照应为 4 个工具');
		const names = recorder.toolSnapshots[1].map((t) => t.nativeToolName);
		assert.deepStrictEqual(names, ['tool_0', 'tool_1', 'tool_2', 'tool_3']);
		// 本地快照同步替换
		assert.strictEqual(conn.tools.length, 4);
	});

	it('刷新失败：第二页发现失败不发布半量列表且进入 error', async () => {
		const recorder = createRecorder();
		// 5 个工具、每页 2 个，第二页（携带 cursor）抛错
		const config = stdioConfig({
			MCP_FIXTURE_TOOLS_COUNT: '5',
			MCP_FIXTURE_PAGE_SIZE: '2',
			MCP_FIXTURE_FAIL_ON_SECOND_PAGE: '1',
		});
		const conn = createConnection(config, recorder);

		await conn.connect();

		assert.strictEqual(conn.status, 'error', '发现失败应进入 error');
		assert.strictEqual(conn.error?.category, 'discovery');
		assert.strictEqual(recorder.toolSnapshots.length, 0, '不得发布半量列表');
		assert.strictEqual(conn.tools.length, 0);
	});
});
