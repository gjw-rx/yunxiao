/**
 * 终端工具 RTK 改写安全测试：覆盖白名单继承、最终命令危险拦截、
 * 原始命令危险拦截与审批内容展示原始/最终命令。
 */
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { TerminalExecTool } from '../../../tools/terminal/terminalExec';
import { ShellWhitelist } from '../../../tools/terminal/shellWhitelist';
import type { ToolContext } from '../../../tools/baseTool';
import { ApprovalGateway, type ApprovalDecision } from '../../../core/approvalGateway';

/** Mock ChildProcess（异步触发事件，确保监听器先注册）。 */
class MockChildProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();

	constructor(private readonly opts: { stdoutData?: string[]; exitCode?: number }) {
		super();
	}

	kill(): boolean {
		this.emit('close', null);
		return true;
	}

	start(): void {
		setTimeout(() => {
			for (const d of this.opts.stdoutData ?? []) {
				this.stdout.emit('data', Buffer.from(d));
			}
			this.emit('close', this.opts.exitCode ?? 0);
		}, 0);
	}
}

/** 捕获审批摘要的 mock ApprovalGateway。 */
function makeCapturingApproval(decision: ApprovalDecision, summaries: string[]): ApprovalGateway {
	return {
		async requestApproval(_tool: string, summary: string): Promise<ApprovalDecision> {
			summaries.push(summary);
			return decision;
		},
		async requestDestructiveApproval(_tool: string, summary: string): Promise<ApprovalDecision> {
			summaries.push(summary);
			return decision;
		},
		shouldGate(): boolean {
			return true;
		},
		clearSession(): void {
			// noop
		},
	} as unknown as ApprovalGateway;
}

/** 构造 mock spawn（记录实际执行的命令）。 */
function makeSpawnRecorder(executed: string[]): (shell: string, args: string[]) => ChildProcess {
	return (_shell, args) => {
		executed.push(args[args.length - 1] as string);
		const proc = new MockChildProcess({ stdoutData: ['ok\n'], exitCode: 0 });
		proc.start();
		return proc as unknown as ChildProcess;
	};
}

describe('TerminalExecTool RTK 改写安全', () => {
	let workspace: string;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], sessionId: 'sess-1', ...overrides };
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-term-hook-'));
		workspace = await fs.realpath(workspace);
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('白名单命令经 RTK 改写后仍自动允许，且执行改写后的命令', async () => {
		const summaries: string[] = [];
		const executed: string[] = [];
		const tool = new TerminalExecTool({
			approval: makeCapturingApproval('allow', summaries),
			shellWhitelist: new ShellWhitelist(['npm test']),
			terminalTimeoutMs: 5000,
			terminalOutputLimit: 10000,
		});
		tool._setSpawnFn(makeSpawnRecorder(executed) as never);

		const context = await makeContext({
			callTransform: {
				originalArgs: { command: 'npm test' },
				finalArgs: { command: 'rtk npm test' },
				transforms: [{ hookId: 'rtk_terminal_transform', args: { command: 'rtk npm test' } }],
			},
		});
		const result = await tool.execute({ command: 'rtk npm test' }, context);

		assert.strictEqual(result.status, 'success');
		// 实际执行最终命令（Windows 下 shellCommand 带 chcp 前缀）
		assert.strictEqual(executed.length, 1);
		assert.ok(executed[0].includes('rtk npm test'));
		assert.strictEqual(summaries.length, 0); // 白名单不弹审批
	});

	it('改写后命令触发危险检查：取消且不显示审批、不执行', async () => {
		const summaries: string[] = [];
		const executed: string[] = [];
		const tool = new TerminalExecTool({
			approval: makeCapturingApproval('allow', summaries),
			shellWhitelist: new ShellWhitelist(['git status']),
			terminalTimeoutMs: 5000,
			terminalOutputLimit: 10000,
		});
		tool._setSpawnFn(makeSpawnRecorder(executed) as never);

		const context = await makeContext({
			callTransform: {
				originalArgs: { command: 'git status' },
				finalArgs: { command: 'rm -rf /' },
				transforms: [{ hookId: 'rtk_terminal_transform', args: { command: 'rm -rf /' } }],
			},
		});
		const result = await tool.execute({ command: 'rm -rf /' }, context);

		assert.strictEqual(result.status, 'cancelled');
		assert.ok(result.error?.includes('危险命令'));
		assert.strictEqual(summaries.length, 0); // 危险命令不弹审批
		assert.deepStrictEqual(executed, []);
	});

	it('原始命令危险时即使改写后安全也拦截', async () => {
		const summaries: string[] = [];
		const executed: string[] = [];
		const tool = new TerminalExecTool({
			approval: makeCapturingApproval('allow', summaries),
			shellWhitelist: new ShellWhitelist([]),
			terminalTimeoutMs: 5000,
			terminalOutputLimit: 10000,
		});
		tool._setSpawnFn(makeSpawnRecorder(executed) as never);

		const context = await makeContext({
			callTransform: {
				originalArgs: { command: 'rm -rf /' },
				finalArgs: { command: 'git status' },
				transforms: [{ hookId: 'rtk_terminal_transform', args: { command: 'git status' } }],
			},
		});
		const result = await tool.execute({ command: 'git status' }, context);

		assert.strictEqual(result.status, 'cancelled');
		assert.strictEqual(summaries.length, 0);
		assert.deepStrictEqual(executed, []);
	});

	it('未知命令审批展示原始命令、改写后命令与转换来源', async () => {
		const summaries: string[] = [];
		const executed: string[] = [];
		const tool = new TerminalExecTool({
			approval: makeCapturingApproval('allow', summaries),
			shellWhitelist: new ShellWhitelist([]), // 全部 unknown
			terminalTimeoutMs: 5000,
			terminalOutputLimit: 10000,
		});
		tool._setSpawnFn(makeSpawnRecorder(executed) as never);

		const context = await makeContext({
			callTransform: {
				originalArgs: { command: 'pytest -q' },
				finalArgs: { command: 'rtk pytest -q' },
				transforms: [{ hookId: 'rtk_terminal_transform', args: { command: 'rtk pytest -q' } }],
			},
		});
		const result = await tool.execute({ command: 'rtk pytest -q' }, context);

		assert.strictEqual(result.status, 'success');
		assert.strictEqual(summaries.length, 1);
		assert.ok(summaries[0].includes('原始命令：pytest -q'));
		assert.ok(summaries[0].includes('改写后命令：rtk pytest -q'));
		assert.ok(summaries[0].includes('转换来源：rtk_terminal_transform'));
		// 批准后执行最终命令
		assert.strictEqual(executed.length, 1);
		assert.ok(executed[0].includes('rtk pytest -q'));
	});

	it('原始白名单但最终命令非等价改写（如 rm x）：弹审批而非自动执行', async () => {
		const summaries: string[] = [];
		const executed: string[] = [];
		const tool = new TerminalExecTool({
			approval: makeCapturingApproval('allow', summaries),
			shellWhitelist: new ShellWhitelist(['npm test']),
			terminalTimeoutMs: 5000,
			terminalOutputLimit: 10000,
		});
		tool._setSpawnFn(makeSpawnRecorder(executed) as never);

		const context = await makeContext({
			callTransform: {
				originalArgs: { command: 'npm test' },
				finalArgs: { command: 'rm x' },
				transforms: [{ hookId: 'rtk_terminal_transform', args: { command: 'rm x' } }],
			},
		});
		const result = await tool.execute({ command: 'rm x' }, context);

		assert.strictEqual(result.status, 'success'); // 审批允许后执行
		assert.strictEqual(summaries.length, 1); // 必须弹审批
		assert.ok(summaries[0].includes('原始命令：npm test'));
		assert.ok(summaries[0].includes('改写后命令：rm x'));
		assert.strictEqual(executed.length, 1);
		assert.ok(executed[0].includes('rm x'));
	});

	it('原始白名单但最终命令非等价且含删除意图：走 destructive 审批', async () => {
		const summaries: string[] = [];
		const executed: string[] = [];
		const tool = new TerminalExecTool({
			approval: makeCapturingApproval('allow', summaries),
			shellWhitelist: new ShellWhitelist(['git status']),
			terminalTimeoutMs: 5000,
			terminalOutputLimit: 10000,
		});
		tool._setSpawnFn(makeSpawnRecorder(executed) as never);

		const context = await makeContext({
			callTransform: {
				originalArgs: { command: 'git status' },
				finalArgs: { command: 'rm -r build' },
				transforms: [{ hookId: 'rtk_terminal_transform', args: { command: 'rm -r build' } }],
			},
		});
		const result = await tool.execute({ command: 'rm -r build' }, context);

		// rm -r 匹配危险模式 → 直接拦截，不弹审批、不执行
		assert.strictEqual(result.status, 'cancelled');
		assert.ok(result.error?.includes('危险命令'));
		assert.strictEqual(summaries.length, 0);
		assert.deepStrictEqual(executed, []);
	});

	it('无转换时审批内容与行为不变（向后兼容）', async () => {
		const summaries: string[] = [];
		const executed: string[] = [];
		const tool = new TerminalExecTool({
			approval: makeCapturingApproval('allow', summaries),
			shellWhitelist: new ShellWhitelist([]),
			terminalTimeoutMs: 5000,
			terminalOutputLimit: 10000,
		});
		tool._setSpawnFn(makeSpawnRecorder(executed) as never);
		const result = await tool.execute({ command: 'pytest -q' }, await makeContext());
		assert.strictEqual(result.status, 'success');
		assert.ok(summaries[0].includes('pytest -q'));
		assert.ok(!summaries[0].includes('改写后命令'));
	});
});
