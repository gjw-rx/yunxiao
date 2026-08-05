import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
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
import { GetDiagnosticsTool } from '../../tools/code/getDiagnostics';
import { WorkspaceSymbolsTool } from '../../tools/code/workspaceSymbols';
import { FindReferencesTool } from '../../tools/code/findReferences';
import { TerminalExecTool } from '../../tools/terminal/terminalExec';
import { ShellWhitelist } from '../../tools/terminal/shellWhitelist';
import { GitStatusTool } from '../../tools/git/gitStatus';
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
	toolCallQueue?: ToolCall[];
	toolResultContent?: string;
	holdMessageStream?: boolean;
}

/** Mock 云端：处理 /message/stream 与 /tool_result，记录请求。 */
class MockCloud {
	private server!: http.Server;
	private queueIndex = 0;
	private sequence = 0;
	readonly toolResults: { call_id: string; status: string; result?: string; error?: string }[] = [];
	readonly messages: { session_id: string; text: string }[] = [];
	port = 0;
	constructor(private readonly opts: MockOptions) { }

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
			if (req.url === '/api/v2/agent/run' && req.method === 'POST') {
				this.messages.push(parsed as unknown as { session_id: string; text: string });
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					success: true,
					data: { run_id: 'run-1', session_id: parsed.session_id, status: 'pending' },
				}));
				return;
			}
			if (req.url === '/api/v2/agent/run/run-1/tool-result' && req.method === 'POST') {
				const results = (parsed as unknown as { results?: { call_id: string; status: string; result?: string; error?: string }[] }).results ?? [];
				this.toolResults.push(...results);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: true, data: null }));
				return;
			}
			if (req.url?.startsWith('/api/v2/agent/run/run-1/events') && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				const toolCall = this.nextToolCall();
				if (toolCall) {
					this.writeRunEvent(res, 'tool_call', { type: 'tool_call', data: [toolCall] });
					if (!this.opts.holdMessageStream) {
						this.writeRunEvent(res, 'run_status', { type: 'run_status', data: { status: 'interrupted' } });
						res.end();
					}
					return;
				}
				if (this.opts.toolResultContent) {
					this.writeRunEvent(res, 'content', { type: 'content', data: this.opts.toolResultContent });
				}
				this.writeRunEvent(res, 'run_status', { type: 'run_status', data: { status: 'completed' } });
				res.end();
				return;
			}
			if (req.url === '/api/agent/invoke/message/stream') {
				this.messages.push(parsed as unknown as { session_id: string; text: string });
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				if (this.opts.toolCallQueue && this.queueIndex < this.opts.toolCallQueue.length) {
					res.write(`data: ${JSON.stringify({ type: 'tool_call', data: [this.opts.toolCallQueue[this.queueIndex++]] })}\n\n`);
				} else if (this.opts.toolCall) {
					res.write(`data: ${JSON.stringify({ type: 'tool_call', data: [this.opts.toolCall] })}\n\n`);
				}
				if (!this.opts.holdMessageStream) {
					res.end();
				}
				return;
			}
			if (req.url === '/api/agent/invoke/tool_result') {
				const results = (parsed as unknown as { results?: { call_id: string; status: string; result?: string; error?: string }[] }).results ?? [];
				this.toolResults.push(...results);
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				if (this.opts.toolCallQueue && this.queueIndex < this.opts.toolCallQueue.length) {
					res.write(`data: ${JSON.stringify({ type: 'tool_call', data: [this.opts.toolCallQueue[this.queueIndex++]] })}\n\n`);
				} else if (this.opts.toolResultContent) {
					res.write(`data: ${JSON.stringify({ type: 'content', data: this.opts.toolResultContent })}\n\n`);
				}
				res.end();
				return;
			}
			res.writeHead(404);
			res.end();
		});
	}

	private nextToolCall(): ToolCall | undefined {
		if (this.opts.toolCallQueue && this.queueIndex < this.opts.toolCallQueue.length) {
			return this.opts.toolCallQueue[this.queueIndex++];
		}
		if (this.opts.toolCall && this.queueIndex === 0) {
			this.queueIndex += 1;
			return this.opts.toolCall;
		}
		return undefined;
	}

	private writeRunEvent(
		res: http.ServerResponse,
		eventType: string,
		payload: Record<string, unknown>,
	): void {
		// v2.1: content 事件 sequence 为 null（瞬态，不落库）；其他事件为单调递增整数
		const sequence = eventType === 'content' ? null : ++this.sequence;
		res.write(`data: ${JSON.stringify({
			sequence,
			event_type: eventType,
			payload,
		})}\n\n`);
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

function waitForToolResult(mock: MockCloud, count = 1, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (mock.toolResults.length >= count) {
				resolve();
			} else if (Date.now() - start > timeoutMs) {
				reject(new Error(`timeout waiting for mock to receive ${count} tool_result(s)`));
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
		store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => { } },
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
			store: { getAlwaysAllow: () => [], addAlwaysAllow: async () => { } },
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

describe('E2E: Phase 3 code intelligence tools vs mock cloud', () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-e2e3-'));
		await fs.writeFile(path.join(workspace, 'hello.txt'), FILE_CONTENT);
	});
	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('get_diagnostics end-to-end: tool_call -> code.get_diagnostics -> tool_result', async function () {
		this.timeout(5000);
		// Arrange
		const mock = new MockCloud({
			toolCall: { call_id: 'c1', tool: 'code.get_diagnostics', args: { file: 'hello.txt' }, site: 'local' },
			toolResultContent: 'done: diagnostics',
		});
		await mock.start();

		const eventBus = new EventBus();
		const registry = new ToolRegistry();
		registry.register(new GetDiagnosticsTool());
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
			manager.sendMessage('s1', 'get diagnostics');
			await waitForStreamEnd(eventBus);

			// Assert：tool_result 回传，状态 success（诊断可能为空，无语言服务）
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].call_id, 'c1');
			assert.strictEqual(mock.toolResults[0].status, 'success');
		} finally {
			await mock.close();
		}
	});

	it('workspace_symbols end-to-end: tool_call -> code.workspace_symbols -> tool_result', async function () {
		this.timeout(5000);
		// Arrange
		const mock = new MockCloud({
			toolCall: { call_id: 'c1', tool: 'code.workspace_symbols', args: { query: 'test' }, site: 'local' },
			toolResultContent: 'done: symbols',
		});
		await mock.start();

		const eventBus = new EventBus();
		const registry = new ToolRegistry();
		registry.register(new WorkspaceSymbolsTool());
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
			manager.sendMessage('s1', 'find symbols');
			await waitForStreamEnd(eventBus);

			// Assert：tool_result 回传，状态 success（符号可能为空）
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].call_id, 'c1');
			assert.strictEqual(mock.toolResults[0].status, 'success');
		} finally {
			await mock.close();
		}
	});

	it('multi-round: find_references -> get_diagnostics', async function () {
		this.timeout(8000);
		// Arrange：toolCallQueue 驱动多轮调用
		const mock = new MockCloud({
			toolCallQueue: [
				{ call_id: 'c1', tool: 'code.find_references', args: { file: 'hello.txt', line: 1, column: 1 }, site: 'local' },
				{ call_id: 'c2', tool: 'code.get_diagnostics', args: { file: 'hello.txt' }, site: 'local' },
			],
			toolResultContent: 'done: multi-round',
		});
		await mock.start();

		const eventBus = new EventBus();
		const registry = new ToolRegistry();
		registry.register(new FindReferencesTool());
		registry.register(new GetDiagnosticsTool());
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
			manager.sendMessage('s1', 'find refs then diagnostics');
			await waitForStreamEnd(eventBus);

			// Assert：两轮 tool_result 均回传
			assert.strictEqual(mock.toolResults.length, 2);
			assert.strictEqual(mock.toolResults[0].call_id, 'c1');
			assert.strictEqual(mock.toolResults[1].call_id, 'c2');
		} finally {
			await mock.close();
		}
	});
});

describe('E2E: Phase 4 terminal & git tools vs mock cloud', () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-e2e4-'));
	});
	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('terminal.exec runs a whitelisted command end-to-end', async function () {
		this.timeout(8000);
		// Arrange：node -v 在默认白名单中，免审批
		const mock = new MockCloud({
			toolCall: {
				call_id: 'c1',
				tool: 'terminal.exec',
				args: { command: 'node -v' },
				site: 'local',
			},
			toolResultContent: 'done: command executed',
		});
		await mock.start();

		const eventBus = new EventBus();
		const approval = autoAllowApproval();
		const registry = new ToolRegistry();
		registry.register(
			new TerminalExecTool({
				approval,
				shellWhitelist: new ShellWhitelist(['node -v']),
				terminalTimeoutMs: 10_000,
			})
		);
		const router = new ToolRouter(registry, approval);
		const client = new AIClient(mock.baseUrl);
		const contents: string[] = [];
		eventBus.on('content', (e) => contents.push(e.payload as string));

		const manager = new SessionManager({
			client,
			router,
			eventBus,
			approval,
			toolTimeoutMs: 15_000,
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
			getToolTimeoutMs: () => 15_000,
		});

		try {
			// Act
			manager.sendMessage('s1', 'run node -v');
			await waitForStreamEnd(eventBus);

			// Assert：命令执行成功，结果回传
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].status, 'success');
			const payload = JSON.parse(mock.toolResults[0].result!);
			assert.strictEqual(payload.exitCode, 0);
			assert.ok(payload.stdout.length > 0);
			assert.ok(contents.includes('done: command executed'));
		} finally {
			await mock.close();
		}
	});

	it('terminal.exec executes a flagged command after approval', async function () {
		this.timeout(5000);
		// Arrange：stderr 重定向会被标记为危险模式，但命令本身只读取 Node 版本
		const mock = new MockCloud({
			toolCall: {
				call_id: 'c1',
				tool: 'terminal.exec',
				args: { command: 'node -v 2>&1' },
				site: 'local',
			},
			toolResultContent: 'done: flagged command approved',
		});
		await mock.start();

		const eventBus = new EventBus();
		const approval = autoAllowApproval();
		const registry = new ToolRegistry();
		registry.register(
			new TerminalExecTool({ approval, shellWhitelist: new ShellWhitelist() })
		);
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
			manager.sendMessage('s1', 'run node -v with stderr redirect');
			await waitForStreamEnd(eventBus);

			// Assert：用户允许后执行并回传成功
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].status, 'success');
			const payload = JSON.parse(mock.toolResults[0].result!);
			assert.strictEqual(payload.exitCode, 0);
		} finally {
			await mock.close();
		}
	});

	it('terminal.exec unknown command approved then executes', async function () {
		this.timeout(8000);
		// Arrange：node -v 不在白名单，走审批（autoAllow）
		const mock = new MockCloud({
			toolCall: {
				call_id: 'c1',
				tool: 'terminal.exec',
				args: { command: 'node -v' },
				site: 'local',
			},
			toolResultContent: 'done: unknown approved',
		});
		await mock.start();

		const eventBus = new EventBus();
		const approval = autoAllowApproval();
		const registry = new ToolRegistry();
		registry.register(
			new TerminalExecTool({
				approval,
				shellWhitelist: new ShellWhitelist(['npm test']),
				terminalTimeoutMs: 10_000,
			})
		);
		const router = new ToolRouter(registry, approval);
		const client = new AIClient(mock.baseUrl);

		const manager = new SessionManager({
			client,
			router,
			eventBus,
			approval,
			toolTimeoutMs: 15_000,
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
			getToolTimeoutMs: () => 15_000,
		});

		try {
			// Act
			manager.sendMessage('s1', 'run node -v');
			await waitForStreamEnd(eventBus);

			// Assert：审批通过后执行成功
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].status, 'success');
			const payload = JSON.parse(mock.toolResults[0].result!);
			assert.strictEqual(payload.exitCode, 0);
			assert.ok(payload.stdout.length > 0);
		} finally {
			await mock.close();
		}
	});

	it('git.status reads repo status end-to-end', async function () {
		this.timeout(8000);
		// Arrange：初始化 git 仓库并创建变更
		execSync('git init', { cwd: workspace });
		execSync('git config user.email test@test.com', { cwd: workspace });
		execSync('git config user.name test', { cwd: workspace });
		await fs.writeFile(path.join(workspace, 'a.txt'), 'a\n');
		await fs.writeFile(path.join(workspace, 'b.txt'), 'b\n');
		execSync('git add a.txt', { cwd: workspace });
		execSync('git commit -m "init"', { cwd: workspace });
		await fs.writeFile(path.join(workspace, 'a.txt'), 'modified\n');
		await fs.writeFile(path.join(workspace, 'c.txt'), 'c\n');

		const mock = new MockCloud({
			toolCall: {
				call_id: 'c1',
				tool: 'git.status',
				args: {},
				site: 'local',
			},
			toolResultContent: 'done: git status',
		});
		await mock.start();

		const eventBus = new EventBus();
		const registry = new ToolRegistry();
		registry.register(new GitStatusTool());
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
			manager.sendMessage('s1', 'git status');
			await waitForStreamEnd(eventBus);

			// Assert：状态查询成功，结果含分支与文件变更
			assert.strictEqual(mock.toolResults.length, 1);
			assert.strictEqual(mock.toolResults[0].status, 'success');
			const payload = JSON.parse(mock.toolResults[0].result!);
			assert.ok(payload.currentBranch);
			// a.txt 已修改（unstaged），c.txt 未跟踪
			assert.ok(payload.unstaged.length > 0);
			assert.ok(payload.untracked.includes('c.txt'));
		} finally {
			await mock.close();
		}
	});

	it('multi-round: terminal.exec(fail) -> code.edit(fix) -> terminal.exec(pass)', async function () {
		this.timeout(15_000);
		// Arrange：创建一个会报错的 JS 文件，第一轮跑测试失败，第二轮修复后通过
		await fs.writeFile(
			path.join(workspace, 'test.js'),
			'const assert = require("assert");\nassert.strictEqual(1, 2); // 故意失败\n'
		);
		const mock = new MockCloud({
			toolCallQueue: [
				{
					call_id: 'c1',
					tool: 'terminal.exec',
					args: { command: 'node test.js' },
					site: 'local',
				},
				{
					call_id: 'c2',
					tool: 'code.edit',
					args: {
						path: 'test.js',
						oldString: 'assert.strictEqual(1, 2); // 故意失败',
						newString: 'assert.strictEqual(1, 1); // 已修复',
					},
					site: 'local',
				},
				{
					call_id: 'c3',
					tool: 'terminal.exec',
					args: { command: 'node test.js' },
					site: 'local',
				},
			],
			toolResultContent: 'done: test fixed and passed',
		});
		await mock.start();

		const eventBus = new EventBus();
		const approval = autoAllowApproval();
		const registry = new ToolRegistry();
		registry.register(
			new TerminalExecTool({
				approval,
				shellWhitelist: new ShellWhitelist(['node test.js']),
				terminalTimeoutMs: 10_000,
			})
		);
		registry.register(new CodeEditTool({ approval, diffViewer: noopDiffViewer() }));
		const router = new ToolRouter(registry, approval);
		const client = new AIClient(mock.baseUrl);

		const manager = new SessionManager({
			client,
			router,
			eventBus,
			approval,
			toolTimeoutMs: 15_000,
			getWorkspaceRoots: () => [workspace],
			getMaxFileSize: () => undefined,
			getToolTimeoutMs: () => 15_000,
		});

		try {
			// Act
			manager.sendMessage('s1', 'run test, fix, rerun');
			await waitForStreamEnd(eventBus, 12_000);

			// Assert：三轮 tool_result 均回传
			assert.strictEqual(mock.toolResults.length, 3);
			// 第一轮：测试失败（exitCode=1）
			assert.strictEqual(mock.toolResults[0].call_id, 'c1');
			assert.strictEqual(mock.toolResults[0].status, 'success');
			const r1 = JSON.parse(mock.toolResults[0].result!);
			assert.strictEqual(r1.exitCode, 1);
			// 第二轮：code.edit 修复
			assert.strictEqual(mock.toolResults[1].call_id, 'c2');
			assert.strictEqual(mock.toolResults[1].status, 'success');
			// 第三轮：测试通过（exitCode=0）
			assert.strictEqual(mock.toolResults[2].call_id, 'c3');
			assert.strictEqual(mock.toolResults[2].status, 'success');
			const r3 = JSON.parse(mock.toolResults[2].result!);
			assert.strictEqual(r3.exitCode, 0);
		} finally {
			await mock.close();
		}
	});
});
