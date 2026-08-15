/**
 * RtkTransformHook - 受信任的 RTK 参数转换 Hook。
 *
 * 仅匹配本地 `terminal_exec` 的 `command` 参数：当 Hooks 总开关与 RTK 集成均启用时，
 * 以无 Shell 子进程调用 `spawn(rtkPath, ['rewrite', command], { shell: false })`，
 * 命令始终作为单个 argv 参数传递（不拼接 Shell 字符串）。
 * 只允许替换 `command` 参数；未启用、无匹配、缺少二进制、超时、非零退出、异常或非法输出
 * 时保持原命令（fail-open）并记录中文日志。
 * 不调用 `rtk init`、不安装或升级 RTK、不注入模型提示词；不影响 simple-git/文件/代码/MCP 工具。
 */
import { spawn } from 'child_process';
import * as logger from '../logger';
import type {
	HookHandler,
	HookHandlerResult,
	HookPayload,
	HooksConfigReader,
	PreToolCallHookPayload,
} from './types';
import { runRtkSpawn, type RtkSpawnFn } from './rtkDetector';

/** 单次 RTK rewrite 调用的默认超时（毫秒）。 */
export const RTK_CALL_TIMEOUT_MS = 5_000;

/** 固定无副作用改写测试样例（不执行实际 Git 命令）。 */
export const RTK_TEST_SAMPLE = 'git status';

/** 固定样例改写测试结果。 */
export interface RtkTestResult {
	/** 固定样例命令。 */
	readonly sample: string;
	/** 改写后的命令（成功时存在）。 */
	readonly rewritten?: string;
	/** 有界错误摘要（失败时存在）。 */
	readonly error?: string;
}

export class RtkTransformHook implements HookHandler {
	/** Hook 唯一标识。 */
	readonly id = 'rtk_terminal_transform';
	/** 仅监听 pre_tool_call。 */
	readonly event: HookHandler['event'] = 'pre_tool_call';
	/** 受信任参数转换器。 */
	readonly kind: HookHandler['kind'] = 'transform';
	/** 稳定优先级（首个内置转换器）。 */
	readonly priority = 100;
	/** 单次执行有界超时（毫秒）。 */
	readonly timeoutMs: number;

	/**
	 * @param config Hooks 配置读取器（总开关与 RTK 启用状态）
	 * @param spawnFn 可注入的 spawn 工厂（测试用）
	 * @param timeoutMs 单次 RTK 调用超时（毫秒），默认 5 秒
	 */
	constructor(
		private readonly config: HooksConfigReader,
		private readonly spawnFn: RtkSpawnFn = spawn,
		timeoutMs: number = RTK_CALL_TIMEOUT_MS
	) {
		this.timeoutMs = timeoutMs;
	}

	/**
	 * 处理 pre_tool_call：仅对 terminal_exec.command 调用 RTK 改写；
	 * 其余工具、未启用或改写失败一律返回 pass（保持原始参数）。
	 *
	 * @param payload 事件载荷
	 * @returns pass（不改写）或 transform（替换 command）
	 */
	async handle(payload: HookPayload): Promise<HookHandlerResult> {
		const pre = payload as PreToolCallHookPayload;
		if (pre.tool !== 'terminal_exec' || typeof pre.args.command !== 'string') {
			return { kind: 'pass' };
		}
		const config = this.config.get();
		if (!config.enabled || !config.rtk.enabled || !config.rtk.executablePath) {
			return { kind: 'pass' };
		}
		const command = pre.args.command;
		const rewritten = await this.rewrite(config.rtk.executablePath, command);
		if (rewritten === null) {
			return { kind: 'pass' };
		}
		logger.log(`[RtkHook] 命令已改写 tool=${pre.tool} callId=${pre.callId} 原始=${command.slice(0, 100)} 改写=${rewritten.slice(0, 100)}`);
		// 只允许替换 command 参数：其余参数原样保留
		return { kind: 'transform', args: { ...pre.args, command: rewritten } };
	}

	/**
	 * 调用 RTK 改写能力：`spawn(rtkPath, ['rewrite', command], { shell: false })`。
	 * 仅当子进程在超时前以退出码 0 返回非空且不同的改写结果时才返回改写命令；
	 * 无匹配、缺少二进制、超时、非零退出、异常或非法输出均返回 null（fail-open）。
	 *
	 * @param rtkPath RTK 可执行文件绝对路径
	 * @param command 原始命令（作为单个 argv 参数传递）
	 * @returns 改写后的命令；失败或无需改写时 null
	 */
	async rewrite(rtkPath: string, command: string): Promise<string | null> {
		const output = await runRtkSpawn(this.spawnFn, rtkPath, ['rewrite', command], this.timeoutMs);
		if (output.timedOut) {
			logger.log(`[RtkHook] RTK rewrite 超时已回退原命令 rtkPath=${rtkPath} 耗时=${this.timeoutMs}ms`);
			return null;
		}
		if (output.error) {
			logger.log(`[RtkHook] 无法启动 RTK（缺少二进制或不可执行）已回退原命令 rtkPath=${rtkPath} error=${output.error}`);
			return null;
		}
		if (output.exitCode !== 0) {
			logger.log(`[RtkHook] RTK rewrite 退出码非零已回退原命令 rtkPath=${rtkPath} exitCode=${output.exitCode}`);
			return null;
		}
		const rewritten = output.stdout.trim();
		if (!rewritten) {
			logger.log(`[RtkHook] RTK rewrite 无改写结果已回退原命令 rtkPath=${rtkPath}`);
			return null;
		}
		if (rewritten === command.trim()) {
			logger.log(`[RtkHook] RTK 返回与原始命令相同，视为无改写 rtkPath=${rtkPath}`);
			return null;
		}
		return rewritten;
	}

	/**
	 * 固定无副作用样例改写测试：仅请求改写 `git status`，不执行样例的实际 Git 命令。
	 *
	 * @returns 样例、改写结果或有界错误摘要
	 */
	async testRewrite(): Promise<RtkTestResult> {
		const config = this.config.get();
		const rtkPath = config.rtk.executablePath;
		if (!rtkPath) {
			logger.log('[RtkHook] 样例测试失败：未配置 RTK 可执行文件路径');
			return { sample: RTK_TEST_SAMPLE, error: '未配置 RTK 可执行文件路径' };
		}
		const rewritten = await this.rewrite(rtkPath, RTK_TEST_SAMPLE);
		if (rewritten === null) {
			logger.log('[RtkHook] 样例测试失败：RTK 不可用或无改写结果');
			return { sample: RTK_TEST_SAMPLE, error: 'RTK 不可用或无改写结果' };
		}
		logger.log(`[RtkHook] 样例测试成功 sample=${RTK_TEST_SAMPLE} rewritten=${rewritten}`);
		return { sample: RTK_TEST_SAMPLE, rewritten };
	}
}
