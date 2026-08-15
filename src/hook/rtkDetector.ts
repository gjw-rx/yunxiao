/**
 * RtkDetector - RTK 可执行文件检测。
 *
 * 使用无 Shell 子进程分别验证 `--version` 与 `rewrite --help`，
 * 返回有界的可用状态、版本与错误摘要；不调用 `rtk init`、不安装或升级 RTK。
 */
import { spawn, type ChildProcess } from 'child_process';
import * as logger from '../logger';

/** 检测单条命令的默认超时（毫秒）。 */
export const RTK_DETECT_TIMEOUT_MS = 5_000;

/** spawn 工厂（可注入供测试 mock）。 */
export type RtkSpawnFn = (
	command: string,
	args: readonly string[],
	opts: { shell: false }
) => ChildProcess;

/** RTK 检测结果：可用状态、版本（可用时）与有界错误摘要。 */
export interface RtkDetectionResult {
	/** 是否可用（版本与 rewrite 能力均验证通过）。 */
	readonly available: boolean;
	/** RTK 版本（--version 输出首行 trim；可用或部分失败时尽力提供）。 */
	readonly version?: string;
	/** 有界错误摘要（不包含完整命令输出与环境变量）。 */
	readonly error?: string;
}

/** 子进程输出快照。 */
export interface RtkSpawnOutput {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	/** 进程启动失败时的错误摘要（如 ENOENT）。 */
	readonly error?: string;
}

/**
 * 检测指定 RTK 可执行文件：依次验证 `--version` 与 `rewrite --help`。
 * 任一验证失败或超时即返回不可用状态与有界错误摘要，不抛异常。
 *
 * @param executablePath RTK 可执行文件绝对路径
 * @param timeoutMs 单条命令超时（毫秒），默认 5 秒
 * @param spawnFn 可注入的 spawn 工厂（测试用）
 * @returns 检测结果
 */
export async function detectRtk(
	executablePath: string,
	timeoutMs: number = RTK_DETECT_TIMEOUT_MS,
	spawnFn: RtkSpawnFn = spawn
): Promise<RtkDetectionResult> {
	const versionOut = await runRtkSpawn(spawnFn, executablePath, ['--version'], timeoutMs);
	if (versionOut.timedOut) {
		logger.log(`[RtkDetector] RTK --version 超时 path=${executablePath} 耗时=${timeoutMs}ms`);
		return { available: false, error: 'RTK 检测超时（--version）' };
	}
	if (versionOut.error) {
		logger.log(`[RtkDetector] 无法启动 RTK path=${executablePath} error=${versionOut.error}`);
		return { available: false, error: `无法启动 RTK 可执行文件: ${versionOut.error}` };
	}
	if (versionOut.exitCode !== 0) {
		logger.log(`[RtkDetector] RTK --version 退出码非零 path=${executablePath} exitCode=${versionOut.exitCode}`);
		return { available: false, error: `RTK --version 退出码非零（${versionOut.exitCode}）` };
	}

	const helpOut = await runRtkSpawn(spawnFn, executablePath, ['rewrite', '--help'], timeoutMs);
	const version = firstLine(versionOut.stdout);
	if (helpOut.timedOut) {
		logger.log(`[RtkDetector] RTK rewrite --help 超时 path=${executablePath}`);
		return { available: false, version, error: 'RTK 检测超时（rewrite --help）' };
	}
	if (helpOut.error) {
		logger.log(`[RtkDetector] 无法启动 RTK rewrite path=${executablePath} error=${helpOut.error}`);
		return { available: false, version, error: `无法启动 RTK rewrite: ${helpOut.error}` };
	}
	if (helpOut.exitCode !== 0) {
		logger.log(`[RtkDetector] RTK rewrite --help 退出码非零 path=${executablePath} exitCode=${helpOut.exitCode}`);
		return { available: false, version, error: `RTK rewrite --help 退出码非零（${helpOut.exitCode}）` };
	}

	logger.log(`[RtkDetector] RTK 检测成功 path=${executablePath} version=${version ?? 'unknown'}`);
	return { available: true, version };
}

/** 单条 RTK 命令输出累积上限（字节），防止外部可执行文件输出无界数据导致 OOM。 */
const MAX_RTK_OUTPUT_BYTES = 64 * 1024;

/**
 * 运行子进程并捕获输出：有界超时（超时即终止）、进程启动失败转为 error 摘要、
 * 输出累积有界（超过上限截断并记录日志，不影响判定）。
 * 供 RTK 检测与 RTK Transform Hook 复用；无 Shell 调用，命令作为独立 argv 参数传递。
 *
 * @param spawnFn spawn 工厂
 * @param command 可执行文件路径
 * @param args 参数列表
 * @param timeoutMs 超时上限（毫秒）
 * @returns 输出快照
 */
export function runRtkSpawn(
	spawnFn: RtkSpawnFn,
	command: string,
	args: readonly string[],
	timeoutMs: number
): Promise<RtkSpawnOutput> {
	return new Promise((resolve) => {
		let proc: ChildProcess;
		try {
			proc = spawnFn(command, [...args], { shell: false });
		} catch (error) {
			resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let outputTruncated = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				// 已退出
			}
		}, timeoutMs);
		const appendBounded = (target: () => string, set: (value: string) => void, chunk: Buffer): void => {
			if (target().length >= MAX_RTK_OUTPUT_BYTES) {
				if (!outputTruncated) {
					outputTruncated = true;
					logger.log(`[RtkDetector] RTK 输出超过上限已截断 limit=${MAX_RTK_OUTPUT_BYTES}bytes`);
				}
				return;
			}
			const remaining = MAX_RTK_OUTPUT_BYTES - target().length;
			set(target() + chunk.toString('utf8').slice(0, remaining));
		};
		proc.stdout?.on('data', (d: Buffer) => {
			appendBounded(() => stdout, (value) => { stdout = value; }, d);
		});
		proc.stderr?.on('data', (d: Buffer) => {
			appendBounded(() => stderr, (value) => { stderr = value; }, d);
		});
		proc.on('error', (err) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: null, timedOut, error: err.message });
		});
		proc.on('close', (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code, timedOut });
		});
	});
}

/**
 * 取输出首行（trim）作为版本号；空输出返回 undefined。
 *
 * @param stdout 子进程标准输出
 * @returns 首行文本
 */
function firstLine(stdout: string): string | undefined {
	const line = stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0)?.trim();
	return line || undefined;
}
