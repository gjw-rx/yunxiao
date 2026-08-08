/**
 * terminal.exec - 受控终端执行（execute 权限，自行处理审批）。
 *
 * 流程：ShellWhitelist.classify ->
 *   dangerous -> ApprovalGateway 审批 -> 允许则执行，拒绝则 cancelled
 *   whitelisted -> 直接执行
 *   unknown -> ApprovalGateway 审批 -> 允许则执行，拒绝则 cancelled
 *
 * 执行：child_process.spawn(shell, [flag, command], { cwd })，捕获 stdout/stderr/exitCode。
 * 超时：setTimeout -> SIGTERM -> 2s 宽限 -> SIGKILL。
 * 取消：监听 context.abortSignal -> proc.kill()。
 * 输出截断：stdout/stderr 各截断至 terminalOutputLimit（保留尾部）。
 * handlesOwnApproval=true：路由层跳过统一审批。
 */
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import { resolveWithinRoots } from '../fs/pathGuard';
import { PathGuardError, ToolValidationError } from '../../core/errors';
import type { ToolSchema } from '../../core/types';
import { ShellWhitelist } from './shellWhitelist';
import type { ApprovalGateway } from '../../core/approvalGateway';
import * as logger from '../../logger';

/** terminal.exec 构造依赖。 */
export interface TerminalExecToolOptions {
	readonly approval: ApprovalGateway;
	readonly shellWhitelist: ShellWhitelist;
	/** 终端执行超时（毫秒），默认 300000。 */
	readonly terminalTimeoutMs?: number;
	/** 终端输出截断上限（字符），默认 10000。 */
	readonly terminalOutputLimit?: number;
}

/** 默认超时 5 分钟。 */
const DEFAULT_TERMINAL_TIMEOUT_MS = 300_000;
/** 默认输出截断上限。 */
const DEFAULT_TERMINAL_OUTPUT_LIMIT = 10_000;
/** SIGTERM 后 SIGKILL 宽限期。 */
const KILL_GRACE_MS = 2_000;

/** spawn 工厂（可注入供测试 mock）。 */
export type SpawnFn = (
	shell: string,
	args: string[],
	opts: { cwd: string }
) => ChildProcess;

export class TerminalExecTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'terminal.exec',
		description:
			'在工作区执行 shell 命令，捕获 stdout/stderr/exitCode。危险命令（rm -rf、管道、重定向等）和未知命令需用户审批；白名单命令（npm test 等）自动放行。用于运行测试/构建/lint。',
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: '要执行的 shell 命令' },
				cwd: {
					type: 'string',
					description: '工作目录（相对工作区根，默认工作区根）',
				},
				timeoutMs: {
					type: 'number',
					description: '本次执行超时（毫秒），覆盖默认值',
				},
			},
			required: ['command'],
		},
		permissions: 'execute',
	};

	readonly handlesOwnApproval = true;

	private readonly approval: ApprovalGateway;
	private readonly shellWhitelist: ShellWhitelist;
	private readonly terminalTimeoutMs: number;
	private readonly terminalOutputLimit: number;
	/** 可注入的 spawn 函数（测试用）。 */
	private readonly spawnFn: SpawnFn;

	constructor(opts: TerminalExecToolOptions) {
		super();
		this.approval = opts.approval;
		this.shellWhitelist = opts.shellWhitelist;
		this.terminalTimeoutMs = opts.terminalTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
		this.terminalOutputLimit =
			opts.terminalOutputLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT;
		this.spawnFn = spawn;
	}

	/**
	 * 为测试注入自定义 spawn 函数。
	 * @internal
	 */
	_setSpawnFn(fn: SpawnFn): void {
		(this as unknown as { spawnFn: SpawnFn }).spawnFn = fn;
	}

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'command');
		if (
			args.cwd !== undefined &&
			args.cwd !== null &&
			(typeof args.cwd !== 'string' || args.cwd.length === 0)
		) {
			throw new ToolValidationError('参数 cwd 必须为非空字符串');
		}
		if (
			args.timeoutMs !== undefined &&
			args.timeoutMs !== null &&
			(typeof args.timeoutMs !== 'number' || args.timeoutMs < 1000 || !Number.isInteger(args.timeoutMs))
		) {
			throw new ToolValidationError('参数 timeoutMs 必须为 >= 1000 的整数');
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const command = args.command as string;
		const startedAt = Date.now();

		// 1. 解析 cwd
		let cwd: string;
		const inputCwd = args.cwd as string | undefined;
		if (inputCwd) {
			try {
				const resolved = await resolveWithinRoots(inputCwd, context.workspaceRoots, {
					followSymlinks: false,
				});
				cwd = resolved.fsPath;
			} catch (err) {
				if (err instanceof PathGuardError) {
					return { status: 'error', error: err.message };
				}
				throw err;
			}
		} else {
			cwd = context.workspaceRoots[0] ?? process.cwd();
		}

		// 2. 命令分类
		const classifyResult = this.shellWhitelist.classify(command);

		if (classifyResult.category === 'dangerous') {
			logger.log(`# [Terminal] 危险命令待审批 - command=${command.slice(0, 100)}, reason=${classifyResult.reason}`);
		}

		// 3. 危险或未知命令交由用户审批
		if (classifyResult.category !== 'whitelisted') {
			const risk = classifyResult.category === 'dangerous'
				? `检测到危险模式：${classifyResult.reason}\n`
				: '';
			const summary = `${risk}terminal.exec 将执行：\n${command}`;
			const decision = await this.approval.requestApproval(
				'terminal.exec',
				summary,
				context.sessionId,
				undefined,
				{ workspaceId: context.workspaceRoots.join('|'), resourcePattern: 'command', commandPattern: command }
			);
			if (decision === 'deny') {
				return {
					status: 'cancelled',
					error: '用户拒绝执行',
					metadata: { duration_ms: Date.now() - startedAt },
				};
			}
		}

		// 4. 执行命令
		const timeoutMs = (args.timeoutMs as number) ?? this.terminalTimeoutMs;
		const outputLimit = context.terminalOutputLimit ?? this.terminalOutputLimit;

		logger.log(`# [Terminal] 开始执行 - command=${command.slice(0, 100)}, cwd=${cwd}`);

		const runResult = await this.runCommand(command, cwd, timeoutMs, outputLimit, context.abortSignal);

		logger.log(
			`# [Terminal] 执行完成 - exitCode=${runResult.exitCode}, duration=${Date.now() - startedAt}ms`
		);

		// 超时 -> error
		if (runResult.terminated === 'timeout') {
			return {
				status: 'error',
				error: `命令执行超时（${Math.round(timeoutMs / 1000)}s）`,
				metadata: { exitCode: runResult.exitCode, duration_ms: Date.now() - startedAt },
			};
		}

		// 取消 -> cancelled
		if (runResult.terminated === 'cancelled') {
			return {
				status: 'cancelled',
				error: '用户取消执行',
				metadata: { exitCode: runResult.exitCode, duration_ms: Date.now() - startedAt },
			};
		}

		return {
			status: 'success',
			result: JSON.stringify(
				{
					stdout: runResult.stdout,
					stderr: runResult.stderr,
					exitCode: runResult.exitCode,
					truncated: runResult.truncated,
				},
				null,
				2
			),
			metadata: {
				exitCode: runResult.exitCode,
				duration_ms: Date.now() - startedAt,
				truncated: runResult.truncated || undefined,
			},
		};
	}

	/** 执行命令并捕获输出，处理超时与取消。 */
	private runCommand(
		command: string,
		cwd: string,
		timeoutMs: number,
		outputLimit: number,
		abortSignal?: AbortSignal
	): Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
		truncated: boolean;
		terminated: 'normal' | 'timeout' | 'cancelled';
	}> {
		return new Promise((resolve) => {
			const { shell, flag } = getShell();
			const proc = this.spawnFn(shell, [flag, command], { cwd });

			let stdout = '';
			let stderr = '';
			let terminated: 'normal' | 'timeout' | 'cancelled' = 'normal';

			proc.stdout?.on('data', (d: Buffer) => {
				stdout += d.toString();
			});
			proc.stderr?.on('data', (d: Buffer) => {
				stderr += d.toString();
			});

			const cleanup = () => {
				clearTimeout(timer);
				abortSignal?.removeEventListener('abort', onAbort);
			};

			const timer = setTimeout(() => {
				terminated = 'timeout';
				killGracefully(proc);
			}, timeoutMs);

			const onAbort = () => {
				terminated = 'cancelled';
				killGracefully(proc);
			};
			abortSignal?.addEventListener('abort', onAbort);

			proc.on('close', (code) => {
				cleanup();
				const truncated = stdout.length > outputLimit || stderr.length > outputLimit;
				const trimmedStdout = stdout.length > outputLimit
					? stdout.slice(stdout.length - outputLimit)
					: stdout;
				const trimmedStderr = stderr.length > outputLimit
					? stderr.slice(stderr.length - outputLimit)
					: stderr;

				resolve({
					stdout: trimmedStdout,
					stderr: trimmedStderr,
					exitCode: code ?? -1,
					truncated,
					terminated,
				});
			});

			proc.on('error', (err) => {
				cleanup();
				resolve({
					stdout: '',
					stderr: `进程启动失败: ${err.message}`,
					exitCode: -1,
					truncated: false,
					terminated: 'normal',
				});
			});
		});
	}
}

/** 获取当前平台的 shell 与参数标志。 */
function getShell(): { shell: string; flag: string } {
	if (process.platform === 'win32') {
		return { shell: process.env.ComSpec ?? 'cmd.exe', flag: '/c' };
	}
	return { shell: process.env.SHELL ?? '/bin/sh', flag: '-c' };
}

/** 优雅杀进程：先 SIGTERM，宽限期后 SIGKILL。 */
function killGracefully(proc: ChildProcess): void {
	try {
		proc.kill('SIGTERM');
	} catch {
		return;
	}
	setTimeout(() => {
		try {
			proc.kill('SIGKILL');
		} catch {
			// 已退出
		}
	}, KILL_GRACE_MS);
}
