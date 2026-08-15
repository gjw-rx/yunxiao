/**
 * RTK Adapter 单元测试：覆盖成功改写、无匹配、二进制缺失、超时、异常、
 * 非零退出、已改写命令、git_status 不受影响与固定样例测试。
 */
import * as assert from 'assert';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { RtkTransformHook, RTK_TEST_SAMPLE } from '../../hook/rtkAdapter';
import type { HooksConfig, HooksConfigReader } from '../../hook/types';
import type { RtkSpawnFn } from '../../hook/rtkDetector';

/** 内存 Hooks 配置读取器。 */
class MemoryConfig implements HooksConfigReader {
	constructor(private config: HooksConfig = { version: 1, enabled: true, rtk: { enabled: true, executablePath: 'C:\\tools\\rtk.exe' } }) {}
	get(): HooksConfig {
		return this.config;
	}
}

/** Mock ChildProcess：模拟 stdout/stderr/close/error 事件。 */
class MockChildProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();

	constructor(
		private readonly opts: {
			stdoutData?: string[];
			exitCode?: number;
			delay?: number;
			startError?: Error;
		}
	) {
		super();
	}

	kill(): boolean {
		this.emit('close', null);
		return true;
	}

	/** 按 delay 输出并退出；startError 时触发 error。 */
	start(): void {
		const delay = this.opts.delay ?? 0;
		setTimeout(() => {
			if (this.opts.startError) {
				this.emit('error', this.opts.startError);
				return;
			}
			for (const d of this.opts.stdoutData ?? []) {
				this.stdout.emit('data', Buffer.from(d));
			}
			this.emit('close', this.opts.exitCode ?? 0);
		}, delay);
	}
}

/** 构造 mock spawn 工厂。 */
function makeMockSpawn(behavior: {
	stdoutData?: string[];
	exitCode?: number;
	delay?: number;
	startError?: Error;
	spawnError?: Error;
	onSpawn?: (args: readonly string[]) => void;
}): RtkSpawnFn {
	return (command, args, opts) => {
		assert.strictEqual(opts.shell, false); // 无 Shell 调用
		behavior.onSpawn?.(args);
		if (behavior.spawnError) {
			throw behavior.spawnError;
		}
		const proc = new MockChildProcess(behavior);
		proc.start();
		return proc as unknown as ChildProcess;
	};
}

/** 构造启用 RTK 的 Hook。 */
function makeHook(spawnFn: RtkSpawnFn, timeoutMs = 100): RtkTransformHook {
	const config = new MemoryConfig();
	return new RtkTransformHook(config, spawnFn, timeoutMs);
}

describe('RtkTransformHook', () => {
	it('成功改写：rewrite 返回改写命令', async () => {
		const spawnFn = makeMockSpawn({ stdoutData: ['rtk git status\n'], exitCode: 0 });
		const hook = makeHook(spawnFn);
		const rewritten = await hook.rewrite('C:\\tools\\rtk.exe', 'git status');
		assert.strictEqual(rewritten, 'rtk git status');
	});

	it('handle 将完整命令作为单个 argv 参数传递（含空格/引号不拆分）', async () => {
		let seenArgs: readonly string[] = [];
		const spawnFn = makeMockSpawn({
			stdoutData: ['rtk git status --porcelain\n'],
			exitCode: 0,
			onSpawn: (args) => { seenArgs = args; },
		});
		const hook = makeHook(spawnFn);
		const result = await hook.handle({
			sessionId: 's1',
			runId: 'r1',
			tool: 'terminal_exec',
			callId: 'c1',
			args: { command: 'git status --porcelain' },
			originalArgs: { command: 'git status --porcelain' },
		});
		assert.deepStrictEqual(seenArgs, ['rewrite', 'git status --porcelain']);
		assert.deepStrictEqual(result, { kind: 'transform', args: { command: 'rtk git status --porcelain' } });
	});

	it('无匹配：空输出保持原命令（pass）', async () => {
		const spawnFn = makeMockSpawn({ stdoutData: [''], exitCode: 0 });
		const hook = makeHook(spawnFn);
		const rewritten = await hook.rewrite('C:\\tools\\rtk.exe', 'git status');
		assert.strictEqual(rewritten, null);
	});

	it('二进制缺失：error 事件回退原命令', async () => {
		const spawnFn = makeMockSpawn({ startError: new Error('ENOENT: no such file') });
		const hook = makeHook(spawnFn);
		const rewritten = await hook.rewrite('C:\\tools\\rtk.exe', 'git status');
		assert.strictEqual(rewritten, null);
	});

	it('spawn 同步抛异常回退原命令', async () => {
		const spawnFn = makeMockSpawn({ spawnError: new Error('EACCES') });
		const hook = makeHook(spawnFn);
		const rewritten = await hook.rewrite('C:\\tools\\rtk.exe', 'git status');
		assert.strictEqual(rewritten, null);
	});

	it('超时：子进程超时后回退原命令', async () => {
		const spawnFn = makeMockSpawn({ stdoutData: ['rtk git status\n'], exitCode: 0, delay: 500 });
		const hook = makeHook(spawnFn, 30);
		const rewritten = await hook.rewrite('C:\\tools\\rtk.exe', 'git status');
		assert.strictEqual(rewritten, null);
	});

	it('非零退出码回退原命令', async () => {
		const spawnFn = makeMockSpawn({ stdoutData: ['rtk git status\n'], exitCode: 2 });
		const hook = makeHook(spawnFn);
		const rewritten = await hook.rewrite('C:\\tools\\rtk.exe', 'git status');
		assert.strictEqual(rewritten, null);
	});

	it('已改写命令：返回与原始相同则视为无改写', async () => {
		const spawnFn = makeMockSpawn({ stdoutData: ['git status\n'], exitCode: 0 });
		const hook = makeHook(spawnFn);
		const rewritten = await hook.rewrite('C:\\tools\\rtk.exe', 'git status');
		assert.strictEqual(rewritten, null);
	});

	it('RTK 未启用时直接 pass 且不调用 spawn', async () => {
		let spawned = false;
		const spawnFn = makeMockSpawn({
			stdoutData: ['rtk git status\n'],
			exitCode: 0,
			onSpawn: () => { spawned = true; },
		});
		const config = new MemoryConfig({ version: 1, enabled: true, rtk: { enabled: false, executablePath: 'C:\\tools\\rtk.exe' } });
		const hook = new RtkTransformHook(config, spawnFn, 100);
		const result = await hook.handle({
			sessionId: 's1',
			runId: 'r1',
			tool: 'terminal_exec',
			callId: 'c1',
			args: { command: 'git status' },
			originalArgs: { command: 'git status' },
		});
		assert.deepStrictEqual(result, { kind: 'pass' });
		assert.strictEqual(spawned, false);
	});

	it('git_status 等非 terminal_exec 工具不受影响（不调用 spawn）', async () => {
		let spawned = false;
		const spawnFn = makeMockSpawn({
			stdoutData: ['rtk git status\n'],
			exitCode: 0,
			onSpawn: () => { spawned = true; },
		});
		const hook = makeHook(spawnFn);
		const result = await hook.handle({
			sessionId: 's1',
			runId: 'r1',
			tool: 'git_status',
			callId: 'c2',
			args: {},
			originalArgs: {},
		});
		assert.deepStrictEqual(result, { kind: 'pass' });
		assert.strictEqual(spawned, false);
	});

	it('terminal_exec 缺 command 参数时 pass（不调用 spawn）', async () => {
		let spawned = false;
		const spawnFn = makeMockSpawn({ stdoutData: ['x\n'], exitCode: 0, onSpawn: () => { spawned = true; } });
		const hook = makeHook(spawnFn);
		const result = await hook.handle({
			sessionId: 's1',
			runId: 'r1',
			tool: 'terminal_exec',
			callId: 'c3',
			args: {},
			originalArgs: {},
		});
		assert.deepStrictEqual(result, { kind: 'pass' });
		assert.strictEqual(spawned, false);
	});

	it('固定样例测试：返回样例与改写结果，且仅请求改写 git status', async () => {
		let seenArgs: readonly string[] = [];
		const spawnFn = makeMockSpawn({
			stdoutData: ['rtk git status\n'],
			exitCode: 0,
			onSpawn: (args) => { seenArgs = args; },
		});
		const hook = makeHook(spawnFn);
		const result = await hook.testRewrite();
		assert.strictEqual(result.sample, RTK_TEST_SAMPLE);
		assert.strictEqual(result.rewritten, 'rtk git status');
		assert.deepStrictEqual(seenArgs, ['rewrite', 'git status']); // 仅固定样例
	});

	it('固定样例测试：未配置路径返回有界错误', async () => {
		const config = new MemoryConfig({ version: 1, enabled: true, rtk: { enabled: true } });
		const hook = new RtkTransformHook(config, makeMockSpawn({ stdoutData: ['x\n'], exitCode: 0 }), 100);
		const result = await hook.testRewrite();
		assert.strictEqual(result.rewritten, undefined);
		assert.ok(result.error);
	});

	it('固定样例测试：改写失败返回有界错误，不抛异常', async () => {
		const spawnFn = makeMockSpawn({ startError: new Error('ENOENT') });
		const hook = makeHook(spawnFn);
		const result = await hook.testRewrite();
		assert.strictEqual(result.rewritten, undefined);
		assert.ok(result.error);
	});
});
