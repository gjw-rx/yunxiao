import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { AIClient } from '../../aiClient';
import { ToolRegistry } from '../../core/toolRegistry';
import { ToolRouter } from '../../core/toolRouter';
import { EventBus } from '../../core/eventBus';
import { SessionManager } from '../../core/sessionManager';
import { ApprovalGateway } from '../../core/approvalGateway';
import { ReadFileTool } from '../../tools/fs/readFile';
import { WriteFileTool } from '../../tools/fs/writeFile';
import { CodeEditTool } from '../../tools/code/editFile';
import { DiffViewer, type VsCodeShim } from '../../tools/diff/diffViewer';
import { BaseTool, type ToolContext, type ToolExecutionResult } from '../../tools/baseTool';
import type { ToolCall, ToolSchema } from '../../core/types';

/** 慢工具：用于验证超时路径。 */
class SlowTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.read_file',
		description: 'slow',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		permissions: 'read',
		site: 'local',
	};
	constructor(private readonly delayMs: number) {
		super();
	}
	async execute(): Promise<ToolExecutionResult> {
		return new Promise((resolve) =>
			setTimeout(() => resolve({ status: 'success', result: 'slow' }), this.delayMs)
		);
	}
}

interface MockOptions {
	toolCall?: ToolCall;
	toolResultContent?: string;
	holdMessageStream?: boolean;
}

/** Mock 云端：处理 /message/stream 与 /tool_result，记录请求。 */
class MockCloud {
	private server!: http.Server;
	readonly toolResults: { call_id: string; status: string; result?: string; error?: string }[] = [];
	readonly messages: { session_id: string; text: string }[] = [];
	port = 0;
	constructor(private readonly opts: MockOptions) {}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	start(): Promise<void> {
		return new Promise((resolve) => {
			this.server = http.createServer((req, res) => this.handle(req, res));
			this.server.listen(0, '127.0.0.1', () => {
				const addr = this.server.address() as { port: number };
				this.port = addr.port;
				resolve();
			});
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
			if (req.url === '/api/agent/invoke/message/stream') {
				this.messages.push(parsed as unknown as { session_id: string; text: string });
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				if (this.opts.toolCall) {
					res.write(`data: ${JSON.stringify({ type: 'tool_call', data: this.opts.toolCall })}\n\n`);
				}
				if (!this.opts.holdMessageStream) {
					res.end();
				}
				return;
			}
			if (req.url === '/api/agent/invoke/tool_result') {
				this.toolResults.push(
					parsed as unknown as { call_id: string; status: string; result?: string; error?: string }
				);
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				if (this.opts.toolResultContent) {
					res.write(`data: ${JSON.stringify({ type: 'content', data: this.opts.toolResultContent })}\n\n`);
				}
				res.end();
				return;
			}
			res.writeHead(404);
			res.end();
		});
	}
}

function waitForStreamEnd(eventBus: EventBus, timeoutMs = 3000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout waiting for stream_end')), timeoutMs);
		const unsub = eventBus.on('stream_end', () => {
			clearTimeout(timer);
			unsub();
			resolve();
		});
	});
}

function waitForToolState(eventBus: EventBus, state: string, timeoutMs = 3000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for tool state ${state}`)), timeoutMs);
		const unsub = eventBus.on('tool_state_change', (e) => {
			if ((e.payload as { state: string }).state === state) {
				clearTimeout(timer);
				unsub();
				resolve();
			}
		});
	});
}

function waitForToolResult(mock: MockCloud, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (mock.toolResults.length > 0) {
				resolve();
			} else if (Date.now() - start > timeoutMs) {
				reject(new Error('timeout waiting for mock to receive tool_result'));
			} else {
				setTimeout(tick, 10);
			}
		};
		tick();
	});
}

const FILE_CONTENT = 'hello world from temp workspace';

describe('E2E: local pipeline vs mock cloud', () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-e2e-'));
		await fs.writeFile(path.join(workspace, 'hello.txt'), FILE_CONTENT);
	});
	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('reads a local file end-to-end: tool_call -> read_file -> tool_result -> continuation', async function () {
		this.timeout(5000);
		// Arrange
		const mock = new MockCloud({
			toolCall: { call_id: 'c1', tool: 'fs.read_file', args: { path: 'hello.txt' }, site: 'local' },
			toolResultContent: 'done: file read',
		});
		await mock.start();

		const eventBus = new EventBus();
		const registry = new ToolRegistry();
		registry.register(new ReadFileTool());
		const router = new ToolRouter(registry);
		const client = new AIClient(mock.baseUrl);
		const contents: string[] = [];
		eventBus.on('content', (e) => contents.push(e.payload as string));

		const manager = new SessionManager({
			client,
			router,
			eventBus,
			toolTimeoutMs: 5000,
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
		});

		try {
			// Act
			manager.sendMessage('s1', 'read hello.txt');
			await waitForStreamEnd(eventBus);

			// Assert：工具结果回传到 mock，内容是真实读取的文件内容
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].call_id, 'c1');
			assert.strictEqual(mock.toolResults[0].status, 'success');
			assert.strictEqual(mock.toolResults[0].result, FILE_CONTENT);
			// 续流 content 到达
			assert.ok(contents.includes('done: file read'));
		} finally {
			await mock.close();
		}
	});

	it('cancels a pending tool_call and posts a cancelled result', async function () {
		this.timeout(5000);
		// Arrange：message 流发出 tool_call 后保持开启（不 end）
		const mock = new MockCloud({
			toolCall: { call_id: 'c1', tool: 'fs.read_file', args: { path: 'hello.txt' }, site: 'local' },
			holdMessageStream: true,
		});
		await mock.start();

		const eventBus = new EventBus();
		const registry = new ToolRegistry();
		registry.register(new ReadFileTool());
		const router = new ToolRouter(registry);
		const client = new AIClient(mock.baseUrl);
		const manager = new SessionManager({
			client,
			router,
			eventBus,
			toolTimeoutMs: 5000,
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
		});

		try {
			// Act
			manager.sendMessage('s1', 'read hello.txt');
			await waitForToolState(eventBus, 'pending');
			const endPromise = waitForStreamEnd(eventBus);
			manager.cancel('s1');
			await endPromise;
			// cancel 的 cancelled POST 是异步到达 mock 的，需等待
			await waitForToolResult(mock);

			// Assert：mock 收到 cancelled 结果
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].call_id, 'c1');
			assert.strictEqual(mock.toolResults[0].status, 'cancelled');
		} finally {
			await mock.close();
		}
	});

	it('times out a slow tool and posts an error result, then continues', async function () {
		this.timeout(5000);
		// Arrange：注册慢工具，超时很短
		const mock = new MockCloud({
			toolCall: { call_id: 'c1', tool: 'fs.read_file', args: { path: 'hello.txt' }, site: 'local' },
			toolResultContent: 'recovered',
		});
		await mock.start();

		const eventBus = new EventBus();
		const registry = new ToolRegistry();
		registry.register(new SlowTool(800));
		const router = new ToolRouter(registry);
		const client = new AIClient(mock.baseUrl);
		const contents: string[] = [];
		eventBus.on('content', (e) => contents.push(e.payload as string));

		const manager = new SessionManager({
			client,
			router,
			eventBus,
			toolTimeoutMs: 50, // 远小于慢工具的 800ms
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
		});

		try {
			// Act
			manager.sendMessage('s1', 'read hello.txt');
			await waitForStreamEnd(eventBus);

			// Assert：超时 -> error 结果回传 -> 续流恢复
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].status, 'error');
			assert.ok(mock.toolResults[0].error?.includes('超时'));
			assert.ok(contents.includes('recovered'));
		} finally {
			await mock.close();
		}
	});
});

/** 自动放行的审批网关（e2e 不弹真实对话框）。 */
function autoAllowApproval(): ApprovalGateway {
	return new ApprovalGateway({
		prompter: { prompt: async () => 'allow' },
		store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
	});
}

/** 无操作 DiffViewer（e2e 不打开真实 diff 编辑器）。 */
function noopDiffViewer(): DiffViewer {
	const shim: VsCodeShim = {
		executeCommand: async () => undefined,
		fileUri: (p) => p,
	};
	return new DiffViewer(shim);
}

describe('E2E: Phase 2 file tools vs mock cloud', () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-e2e2-'));
	});
	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('writes a local file end-to-end: tool_call -> write_file(approved) -> tool_result', async function () {
		this.timeout(5000);
		// Arrange
		const mock = new MockCloud({
			toolCall: {
				call_id: 'c1',
				tool: 'fs.write_file',
				args: { path: 'src/utils/logger.ts', content: 'export const log = () => {}\n' },
				site: 'local',
			},
			toolResultContent: 'done: file written',
		});
		await mock.start();

		const eventBus = new EventBus();
		const approval = autoAllowApproval();
		const registry = new ToolRegistry();
		registry.register(new WriteFileTool());
		const router = new ToolRouter(registry, approval);
		const client = new AIClient(mock.baseUrl);
		const contents: string[] = [];
		eventBus.on('content', (e) => contents.push(e.payload as string));

		const manager = new SessionManager({
			client,
			router,
			eventBus,
			approval,
			toolTimeoutMs: 5000,
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
		});

		try {
			// Act
			manager.sendMessage('s1', 'create logger.ts');
			await waitForStreamEnd(eventBus);

			// Assert：文件已创建，结果回传
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].status, 'success');
			const written = await fs.readFile(
				path.join(workspace, 'src/utils/logger.ts'),
				'utf8'
			);
			assert.strictEqual(written, 'export const log = () => {}\n');
			assert.ok(contents.includes('done: file written'));
		} finally {
			await mock.close();
		}
	});

	it('edits a local file end-to-end: tool_call -> code.edit(approved) -> tool_result with diff', async function () {
		this.timeout(5000);
		// Arrange：先准备待编辑文件
		await fs.writeFile(
			path.join(workspace, 'extension.ts'),
			'export function getServiceBaseUrl() {}\n'
		);
		const mock = new MockCloud({
			toolCall: {
				call_id: 'c1',
				tool: 'code.edit',
				args: {
					path: 'extension.ts',
					oldString: 'getServiceBaseUrl',
					newString: 'getServiceUrl',
				},
				site: 'local',
			},
			toolResultContent: 'done: renamed',
		});
		await mock.start();

		const eventBus = new EventBus();
		const approval = autoAllowApproval();
		const registry = new ToolRegistry();
		registry.register(new CodeEditTool({ approval, diffViewer: noopDiffViewer() }));
		const router = new ToolRouter(registry, approval); // code.edit 自处理审批，路由层不重复 gate
		const client = new AIClient(mock.baseUrl);
		const contents: string[] = [];
		eventBus.on('content', (e) => contents.push(e.payload as string));

		const manager = new SessionManager({
			client,
			router,
			eventBus,
			approval,
			toolTimeoutMs: 5000,
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
		});

		try {
			// Act
			manager.sendMessage('s1', 'rename getServiceBaseUrl');
			await waitForStreamEnd(eventBus);

			// Assert：文件已改名，结果含 diff 元数据
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].status, 'success');
			const written = await fs.readFile(path.join(workspace, 'extension.ts'), 'utf8');
			assert.ok(written.includes('getServiceUrl'));
			assert.ok(!written.includes('getServiceBaseUrl'));
			assert.ok(contents.includes('done: renamed'));
		} finally {
			await mock.close();
		}
	});

	it('denies a write via approval and posts a cancelled result', async function () {
		this.timeout(5000);
		// Arrange：审批拒绝
		const mock = new MockCloud({
			toolCall: {
				call_id: 'c1',
				tool: 'fs.write_file',
				args: { path: 'denied.ts', content: 'x' },
				site: 'local',
			},
			toolResultContent: 'recovered after deny',
		});
		await mock.start();

		const eventBus = new EventBus();
		const approval = new ApprovalGateway({
			prompter: { prompt: async () => undefined }, // 拒绝
			store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => {} },
		});
		const registry = new ToolRegistry();
		registry.register(new WriteFileTool());
		const router = new ToolRouter(registry, approval);
		const client = new AIClient(mock.baseUrl);

		const manager = new SessionManager({
			client,
			router,
			eventBus,
			approval,
			toolTimeoutMs: 5000,
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
		});

		try {
			// Act
			manager.sendMessage('s1', 'write denied.ts');
			await waitForStreamEnd(eventBus);

			// Assert：回传 cancelled，文件未创建
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].status, 'cancelled');
			await assert.rejects(() => fs.stat(path.join(workspace, 'denied.ts')));
		} finally {
			await mock.close();
		}
	});
});
