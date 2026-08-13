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

/** Mock ChildProcess：模拟 stdout/stderr/exit 事件。 */
class MockChildProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly pid = 12345;

	constructor(
		private readonly opts: {
			stdoutData?: string[];
			stderrData?: string[];
			exitCode?: number;
			delay?: number;
		}
	) {
		super();
	}

	killed = false;
	kill(signal?: string): boolean {
		this.killed = true;
		this._emit();
		return true;
	}

	/** 模拟进程输出与退出。 */
	start(): void {
		const delay = this.opts.delay ?? 0;
		setTimeout(() => {
			for (const d of this.opts.stdoutData ?? []) {
				this.stdout.emit('data', Buffer.from(d));
			}
			for (const d of this.opts.stderrData ?? []) {
				this.stderr.emit('data', Buffer.from(d));
			}
			this.emit('close', this.opts.exitCode ?? 0);
		}, delay);
	}

	private _emit(): void {
		// kill 后立即触发 close
		this.emit('close', null);
	}
}

/** 构造 mock ApprovalGateway。 */
function makeMockApproval(decision: ApprovalDecision): ApprovalGateway {
	return {
	async requestApproval(): Promise<ApprovalDecision> {
			return decision;
		},
		async requestDestructiveApproval(): Promise<ApprovalDecision> {
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

/** 构造 mock spawn 函数。 */
function makeMockSpawn(opts: {
	stdoutData?: string[];
	stderrData?: string[];
	exitCode?: number;
	delay?: number;
}): (shell: string, args: string[], opts2: { cwd: string }) => ChildProcess {
	return () => {
		const proc = new MockChildProcess(opts);
		proc.start();
		return proc as unknown as ChildProcess;
	};
}

describe('TerminalExecTool', () => {
	let workspace: string;

	async function makeContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
		return { workspaceRoots: [workspace], sessionId: 'sess-1', ...overrides };
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'yunxiao-term-'));
		workspace = await fs.realpath(workspace);
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it('成功执行命令（exitCode=0）', async () => {
		// Arrange
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['npm test']),
			terminalTimeoutMs: 5000,
			terminalOutputLimit: 10000,
		});
		tool._setSpawnFn(makeMockSpawn({
			stdoutData: ['2 passing\n'],
			exitCode: 0,
		}));

		// Act
		const result = await tool.execute({ command: 'npm test' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.exitCode, 0);
		assert.strictEqual(payload.stdout, '2 passing\n');
		assert.strictEqual(payload.truncated, false);
		assert.strictEqual(result.metadata?.exitCode, 0);
	});

	it('Windows 下通过 UTF-8 代码页执行命令', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}

		let capturedCommand = '';
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['npm test']),
		});
		tool._setSpawnFn((_shell, args) => {
			capturedCommand = args[1] ?? '';
			const proc = new MockChildProcess({ exitCode: 0 });
			proc.start();
			return proc as unknown as ChildProcess;
		});

		await tool.execute({ command: 'npm test' }, await makeContext());

		assert.strictEqual(capturedCommand, 'chcp 65001 > nul & npm test');
	});

	it('exitCode 非 0 仍为 success', async () => {
		// Arrange
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['npm test']),
		});
		tool._setSpawnFn(makeMockSpawn({
			stdoutData: ['1 failing\n'],
			stderrData: ['AssertionError\n'],
			exitCode: 1,
		}));

		// Act
		const result = await tool.execute({ command: 'npm test' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.exitCode, 1);
		assert.ok(payload.stderr.includes('AssertionError'));
	});

	it('含重定向的危险命令直接拦截', async () => {
		// 准备
		let approvalCalled = false;
		let spawnCalled = false;
		const approval = makeMockApproval('allow');
		approval.requestApproval = async (): Promise<ApprovalDecision> => {
			approvalCalled = true;
			return 'allow';
		};
		const tool = new TerminalExecTool({
			approval,
			shellWhitelist: new ShellWhitelist(),
		});
		tool._setSpawnFn(() => {
			spawnCalled = true;
			const proc = new MockChildProcess({});
			proc.start();
			return proc as unknown as ChildProcess;
		});

		// 执行
		const result = await tool.execute(
			{ command: 'openspec list --json 2>&1' },
			await makeContext()
		);

		// 断言
		assert.strictEqual(result.status, 'cancelled');
		assert.ok(result.error?.includes('危险命令已被拦截'));
		assert.strictEqual(approvalCalled, false);
		assert.strictEqual(spawnCalled, false);
	});

	it('危险命令直接拦截且不执行', async () => {
		// 准备
		let spawnCalled = false;
		const approval = makeMockApproval('allow');
		let approvalCalled = false;
		approval.requestApproval = async () => {
			approvalCalled = true;
			return 'allow';
		};
		const tool = new TerminalExecTool({
			approval,
			shellWhitelist: new ShellWhitelist(),
		});
		tool._setSpawnFn(() => {
			spawnCalled = true;
			return new MockChildProcess({}) as unknown as ChildProcess;
		});

		// 执行
		const result = await tool.execute({ command: 'rm -rf /' }, await makeContext());

		// 断言
		assert.strictEqual(result.status, 'cancelled');
		assert.ok(result.error?.includes('危险命令已被拦截'));
		assert.strictEqual(approvalCalled, false);
		assert.strictEqual(spawnCalled, false);
	});

	it('删除命令使用 destructive 审批而非普通审批', async () => {
		let destructiveCalled = false;
		const approval = makeMockApproval('allow');
		approval.requestDestructiveApproval = async () => {
			destructiveCalled = true;
			return 'allow';
		};
		const tool = new TerminalExecTool({ approval, shellWhitelist: new ShellWhitelist() });
		tool._setSpawnFn(makeMockSpawn({ exitCode: 0 }));
		const result = await tool.execute({ command: 'rm obsolete.txt' }, await makeContext());
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(destructiveCalled, true);
	});

	it('ShellWhitelist 识别各平台删除命令', () => {
		const whitelist = new ShellWhitelist();
		for (const command of ['rm file.txt', 'rmdir cache', 'del cache.txt', 'erase cache.txt', 'Remove-Item cache.txt', 'git clean -fd']) {
			assert.strictEqual(whitelist.isDeletionCommand(command), true, command);
		}
		assert.strictEqual(whitelist.isDeletionCommand('npm test'), false);
	});

	it('白名单命令免审批直接执行', async () => {
		// Arrange
		let approvalCalled = false;
		const approval = makeMockApproval('allow');
		const origRequest = approval.requestApproval;
		approval.requestApproval = async () => {
			approvalCalled = true;
			return 'allow';
		};
		const tool = new TerminalExecTool({
			approval,
			shellWhitelist: new ShellWhitelist(['npm run lint']),
		});
		tool._setSpawnFn(makeMockSpawn({ stdoutData: ['lint ok\n'], exitCode: 0 }));

		// Act
		await tool.execute({ command: 'npm run lint' }, await makeContext());

		// Assert
		assert.strictEqual(approvalCalled, false);
	});

	it('unknown 命令审批允许后执行', async () => {
		// Arrange
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['npm test']),
		});
		tool._setSpawnFn(makeMockSpawn({ stdoutData: ['done\n'], exitCode: 0 }));

		// Act
		const result = await tool.execute({ command: 'python script.py' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(JSON.parse(result.result!).exitCode, 0);
	});

	it('完全访问自动批准未知的非删除命令', async () => {
		let promptCalled = false;
		const approval = new ApprovalGateway({
			prompter: {
				async prompt(): Promise<ApprovalDecision> {
					promptCalled = true;
					return 'deny';
				},
			},
			store: {
				getAlwaysAllow: () => [],
				addAlwaysAllow: async () => {},
				getApprovalMode: () => 'full-access',
			},
		});
		const tool = new TerminalExecTool({ approval, shellWhitelist: new ShellWhitelist() });
		tool._setSpawnFn(makeMockSpawn({ exitCode: 0 }));
		const result = await tool.execute({ command: 'python script.py' }, await makeContext());
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(promptCalled, false);
	});

	it('unknown 命令审批拒绝返回 cancelled', async () => {
		// Arrange
		let spawnCalled = false;
		const tool = new TerminalExecTool({
			approval: makeMockApproval('deny'),
			shellWhitelist: new ShellWhitelist(['npm test']),
		});
		tool._setSpawnFn(() => {
			spawnCalled = true;
			return new MockChildProcess({}) as unknown as ChildProcess;
		});

		// Act
		const result = await tool.execute({ command: 'python script.py' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'cancelled');
		assert.ok(result.error?.includes('用户拒绝执行'));
		assert.strictEqual(spawnCalled, false);
	});

	it('输出截断保留尾部', async () => {
		// Arrange
		const longOutput = 'A'.repeat(15000);
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['npm test']),
			terminalOutputLimit: 5000,
		});
		tool._setSpawnFn(makeMockSpawn({ stdoutData: [longOutput], exitCode: 0 }));

		// Act
		const result = await tool.execute({ command: 'npm test' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.truncated, true);
		assert.strictEqual(payload.stdout.length, 5000);
		assert.strictEqual(payload.stdout, 'A'.repeat(5000));
	});

	it('空 command 校验拒绝', () => {
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(),
		});
		assert.throws(() => tool.validate({ command: '' }));
	});

	it('timeoutMs < 1000 校验拒绝', () => {
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(),
		});
		assert.throws(() => tool.validate({ command: 'ls', timeoutMs: 500 }));
	});

	it('可选参数为 null 时使用默认值', async () => {
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['ls']),
		});
		tool._setSpawnFn(makeMockSpawn({ exitCode: 0 }));

		const result = await tool.execute(
			{ command: 'ls', cwd: null, timeoutMs: null },
			await makeContext()
		);

		assert.strictEqual(result.status, 'success');
	});

	it('cwd 解析到工作区子目录', async () => {
		// Arrange
		await fs.mkdir(path.join(workspace, 'subdir'), { recursive: true });
		let capturedCwd = '';
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['npm test']),
		});
		tool._setSpawnFn((_shell, _args, opts2) => {
			capturedCwd = opts2.cwd;
			const proc = new MockChildProcess({ exitCode: 0 });
			proc.start();
			return proc as unknown as ChildProcess;
		});

		// Act
		await tool.execute({ command: 'npm test', cwd: 'subdir' }, await makeContext());

		// Assert
		assert.strictEqual(capturedCwd, path.join(workspace, 'subdir'));
	});

	it('cwd 越界返回 error', async () => {
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['npm test']),
		});

		const result = await tool.execute(
			{ command: 'npm test', cwd: '../../../etc' },
			await makeContext()
		);

		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('越界'));
	});

	it('超时返回 error', async () => {
		// Arrange
		const tool = new TerminalExecTool({
			approval: makeMockApproval('allow'),
			shellWhitelist: new ShellWhitelist(['npm test']),
			terminalTimeoutMs: 100,
		});
		// 进程不退出，等超时 kill
		tool._setSpawnFn(() => {
			const proc = new EventEmitter() as unknown as Record<string, unknown>;
			proc.stdout = new EventEmitter();
			proc.stderr = new EventEmitter();
			proc.pid = 999;
			proc.killed = false;
			(proc as { kill: () => boolean }).kill = () => {
				proc.killed = true;
				(proc as { emit: (e: string, c: number | null) => boolean }).emit('close', null);
				return true;
			};
			return proc as unknown as ChildProcess;
		});

		// Act
		const result = await tool.execute({ command: 'npm test' }, await makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.ok(result.error?.includes('超时'));
	});
});
