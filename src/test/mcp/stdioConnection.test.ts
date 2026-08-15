/**
 * McpServerConnection STDIO 初始化测试（任务 7.2）。
 *
 * 覆盖：trusted 工作区连接就绪、不可信工作区保持 waiting 不 spawn、command 不存在
 * 进入 error(spawn)、cwd/env 装配与 stderr 有界消费、连接超时 error(timeout)、
 * 协议不兼容 error(protocol) 与状态迁移顺序。
 *
 * 通过真实 fixture 子进程（out/test/mcp/fixtures/stdioServer.js）验证 STDIO Transport
 * 端到端生命周期；每个用例 afterEach 释放 Connection 以避免悬挂子进程。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServerConnection, type McpConnectionCallbacks } from '../../mcp/connection';
import type { McpTransportHandle } from '../../mcp/transportFactory';
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
function stdioConfig(env: Record<string, string> = {}, opts?: { readonly cwd?: string; readonly connectTimeoutMs?: number; readonly command?: string; readonly args?: readonly string[] }): StdioMcpRuntimeConfig {
	return {
		type: 'stdio',
		command: opts?.command ?? 'node',
		args: [...(opts?.args ?? [FIXTURE_PATH])],
		env,
		...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
		enabled: true,
		connectTimeoutMs: opts?.connectTimeoutMs ?? 10000,
		callTimeoutMs: 10000,
	};
}

/** 创建 Connection 并登记到清理列表。 */
function createConnection(
	config: StdioMcpRuntimeConfig,
	recorder: Recorder,
	opts?: { readonly workspaceTrusted?: boolean; readonly workspaceCwd?: string; readonly transportFactory?: (config: McpServerRuntimeConfig, workspaceCwd?: string) => McpTransportHandle }
): McpServerConnection {
	const conn = new McpServerConnection({
		serverId: 'fixture',
		config,
		workspaceTrusted: opts?.workspaceTrusted ?? true,
		...(opts?.workspaceCwd !== undefined ? { workspaceCwd: opts.workspaceCwd } : {}),
		...(opts?.transportFactory ? { transportFactory: opts.transportFactory } : {}),
		callbacks: recorder.callbacks,
	});
	created.push(conn);
	return conn;
}

/** 已创建 Connection 列表（afterEach 统一释放）。 */
const created: McpServerConnection[] = [];

/** 等待毫秒。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('McpServerConnection STDIO 初始化（7.2）', () => {
	afterEach(async () => {
		const conns = created.splice(0);
		await Promise.all(conns.map((c) => c.dispose()));
		// 释放后再等一拍，让 SDK 后台清理子进程
		await sleep(50);
	});

	it('trusted 工作区：连接就绪并发布完整工具与 instructions', async () => {
		const recorder = createRecorder();
		const config = stdioConfig({ MCP_FIXTURE_TOOLS_COUNT: '3', MCP_FIXTURE_INSTRUCTIONS: '使用 CodeGraph 查询代码' });
		const conn = createConnection(config, recorder);

		await conn.connect();

		assert.strictEqual(conn.status, 'ready');
		assert.strictEqual(conn.actualTransport, 'stdio');
		assert.strictEqual(conn.tools.length, 3);
		assert.strictEqual(conn.tools[0].nativeToolName, 'tool_0');
		// 只在完整发现后发布一次
		assert.strictEqual(recorder.toolSnapshots.length, 1);
		assert.strictEqual(recorder.toolSnapshots[0].length, 3);
		// instructions 快照已发布
		assert.ok(conn.instructions);
		assert.strictEqual(conn.instructions!.content, '使用 CodeGraph 查询代码');
		assert.strictEqual(conn.instructions!.truncated, false);
	});

	it('不可信工作区：保持 waiting_workspace_trust 且不创建 Transport', async () => {
		const recorder = createRecorder();
		let spawned = false;
		const throwingFactory = (): McpTransportHandle => {
			spawned = true;
			throw new Error('不应在不可信工作区创建 Transport');
		};
		const conn = createConnection(stdioConfig(), recorder, { workspaceTrusted: false, transportFactory: throwingFactory });

		await conn.connect();

		assert.strictEqual(conn.status, 'waiting_workspace_trust');
		assert.strictEqual(spawned, false);
		assert.strictEqual(recorder.toolSnapshots.length, 0);
		assert.strictEqual(conn.tools.length, 0);
	});

	it('command 不存在：进入 error(spawn) 且不发布工具', async () => {
		const recorder = createRecorder();
		const config = stdioConfig({}, { command: 'this-command-does-not-exist-xyz', args: [] });
		const conn = createConnection(config, recorder);

		await conn.connect();

		assert.strictEqual(conn.status, 'error');
		assert.strictEqual(conn.error?.category, 'spawn');
		assert.strictEqual(recorder.toolSnapshots.length, 0);
		assert.strictEqual(conn.tools.length, 0);
	});

	it('cwd/env 装配：子进程收到配置的 cwd 与 env，stderr 有界消费', async () => {
		const recorder = createRecorder();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-cwd-'));
		const config = stdioConfig(
			{ FIXTURE_MARKER: 'marker-123', MCP_FIXTURE_INSPECT_STDERR: '1' },
			{ cwd }
		);
		const conn = createConnection(config, recorder);

		await conn.connect();

		assert.strictEqual(conn.status, 'ready');
		// fixture 向 stderr 写入 {cwd, marker} 的 JSON；解析后断言装配正确
		const tail = (conn.stderrTail ?? '').trim();
		assert.ok(tail.length > 0, 'stderr 应有 inspect 输出');
		const inspected = JSON.parse(tail) as { cwd: string; marker: string };
		assert.strictEqual(inspected.cwd, cwd, '子进程 cwd 应为配置的工作目录');
		assert.strictEqual(inspected.marker, 'marker-123', '子进程 env 应包含配置标记');
	});

	it('连接超时：进入 error(timeout)', async () => {
		const recorder = createRecorder();
		const config = stdioConfig({ MCP_FIXTURE_HANG_INIT: '1' }, { connectTimeoutMs: 800 });
		const conn = createConnection(config, recorder);

		await conn.connect();

		assert.strictEqual(conn.status, 'error');
		assert.strictEqual(conn.error?.category, 'timeout');
		assert.strictEqual(recorder.toolSnapshots.length, 0);
	});

	it('协议不兼容：进入 error(protocol)', async () => {
		const recorder = createRecorder();
		const config = stdioConfig({ MCP_FIXTURE_BAD_PROTOCOL: '1' });
		const conn = createConnection(config, recorder);

		await conn.connect();

		assert.strictEqual(conn.status, 'error');
		assert.strictEqual(conn.error?.category, 'protocol');
		assert.strictEqual(recorder.toolSnapshots.length, 0);
	});

	it('状态迁移：成功路径为 connecting → ready', async () => {
		const recorder = createRecorder();
		const conn = createConnection(stdioConfig({ MCP_FIXTURE_TOOLS_COUNT: '1' }), recorder);

		await conn.connect();

		const transitions = recorder.statuses.map((s) => s.status);
		assert.deepStrictEqual(transitions, ['connecting', 'ready']);
	});

	it('状态迁移：失败路径为 connecting → error', async () => {
		const recorder = createRecorder();
		const conn = createConnection(stdioConfig({ MCP_FIXTURE_HANG_INIT: '1' }, { connectTimeoutMs: 800 }), recorder);

		await conn.connect();

		const transitions = recorder.statuses.map((s) => s.status);
		assert.deepStrictEqual(transitions, ['connecting', 'error']);
		assert.strictEqual(recorder.statuses[1].error?.category, 'timeout');
	});
});
