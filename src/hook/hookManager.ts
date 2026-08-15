/**
 * HookManager - 异步 Hooks 运行时核心。
 *
 * 仅注册扩展内置的受信任 Hook（不加载工作区、网络、脚本路径或 npm 包中的第三方 Hook）。
 * 同一事件的 Handler 按稳定优先级串行执行，每个 Handler 有有界超时；
 * 普通观察 Hook 的异常、超时或无效返回被记录后隔离，不得击穿 AgentLoop 或工具执行。
 * pre_tool_call 特殊派发：先运行受信任转换器链（可替换 args），再运行守卫链（可显式阻断），
 * 均按稳定优先级执行；转换异常、超时或无效返回保持原始参数（fail-open）。
 */
import * as logger from '../logger';
import type {
	HookDispatchTrace,
	HookEventName,
	HookHandler,
	HookHandlerKind,
	HookHandlerResult,
	HookPayload,
	HookTransformEntry,
	HooksConfigReader,
	PostToolCallHookPayload,
	PreToolCallDispatchResult,
	PreToolCallHookPayload,
	SessionHookPayload,
} from './types';

/** 带超时的 Promise 执行结果：'timeout' 表示超时。 */
type TimedResult<T> = T | 'timeout';

/** 单个 Handler 的执行结果（trace + 可选返回）。 */
interface HandlerRun {
	readonly trace: HookDispatchTrace;
	readonly result?: HookHandlerResult;
}

export class HookManager {
	/** 已注册的内置 Hook 注册表（按 ID 唯一）。 */
	private readonly handlers = new Map<string, HookHandler>();

	/**
	 * @param config Hooks 配置读取器（总开关关闭时跳过所有派发）。
	 */
	constructor(private readonly config: HooksConfigReader) {}

	/**
	 * 注册扩展内置的受信任 Hook；重复 ID 抛错。
	 *
	 * @param handler 待注册的 Hook Handler
	 * @returns void
	 */
	register(handler: HookHandler): void {
		if (this.handlers.has(handler.id)) {
			throw new Error(`Hook 已注册，不可重复注册: ${handler.id}`);
		}
		this.handlers.set(handler.id, handler);
		logger.log(`[HookManager] 注册内置 Hook id=${handler.id} event=${handler.event} kind=${handler.kind} priority=${handler.priority}`);
	}

	/**
	 * 注销指定 Hook（幂等）。
	 *
	 * @param id Hook ID
	 * @returns void
	 */
	unregister(id: string): void {
		if (this.handlers.delete(id)) {
			logger.log(`[HookManager] 注销 Hook id=${id}`);
		}
	}

	/**
	 * 列出全部已注册 Hook（按注册顺序）。
	 *
	 * @returns 已注册 Hook 列表
	 */
	list(): readonly HookHandler[] {
		return [...this.handlers.values()];
	}

	/**
	 * 派发非转换事件（session_start / session_end / post_tool_call）：
	 * 串行按稳定优先级执行，超时与异常均记录后隔离，不影响调用方。
	 *
	 * @param event 事件名（pre_tool_call 请使用 dispatchPreToolCall）
	 * @param payload 事件载荷
	 * @returns 各 Handler 的执行轨迹
	 */
	async dispatch(event: HookEventName, payload: HookPayload): Promise<readonly HookDispatchTrace[]> {
		if (event === 'pre_tool_call') {
			logger.log(`[HookManager] pre_tool_call 请使用 dispatchPreToolCall，跳过普通派发`);
			return [];
		}
		const config = this.config.get();
		if (!config.enabled) {
			logger.log(`[HookManager] Hooks 总开关关闭，跳过事件 event=${event}`);
			return [];
		}
		const traces: HookDispatchTrace[] = [];
		for (const handler of this.orderedHandlers(event)) {
			const { trace } = await this.runOne(handler, payload);
			traces.push(trace);
		}
		return traces;
	}

	/**
	 * 派发 pre_tool_call：先按稳定优先级运行受信任转换器链（可替换 args），
	 * 再运行守卫链（可显式阻断）。任一 guard 显式阻断即取消后续处理并返回阻断结果；
	 * 转换异常、超时或无效返回保持当前参数继续。
	 *
	 * @param payload pre_tool_call 载荷（args 为初始校验后的参数）
	 * @returns 是否阻断、最终参数与转换轨迹
	 */
	async dispatchPreToolCall(payload: PreToolCallHookPayload): Promise<PreToolCallDispatchResult> {
		const config = this.config.get();
		const unchanged: PreToolCallDispatchResult = {
			blocked: false,
			args: payload.args,
			transforms: [],
		};
		if (!config.enabled) {
			logger.log(`[HookManager] Hooks 总开关关闭，跳过 pre_tool_call tool=${payload.tool}`);
			return unchanged;
		}
		if (this.handlers.size === 0) {
			return unchanged;
		}

		// 1. 受信任转换器链：按优先级串行，后续转换器基于前一转换结果继续。
		let args = payload.args;
		const transforms: HookTransformEntry[] = [];
		for (const handler of this.orderedHandlers('pre_tool_call', 'transform')) {
			const { trace, result } = await this.runOne(handler, { ...payload, args });
			if (result?.kind === 'transform') {
				args = result.args;
				transforms.push({ hookId: handler.id, args: result.args });
				logger.log(`[HookManager] 受信任转换已应用 hookId=${handler.id} tool=${payload.tool} transforms=${transforms.length}`);
			}
		}

		// 2. 守卫链：任一显式阻断即返回 cancelled。
		for (const handler of this.orderedHandlers('pre_tool_call', 'guard')) {
			const { trace, result } = await this.runOne(handler, { ...payload, args });
			if (result?.kind === 'block') {
				logger.log(`[HookManager] Guard 显式阻断工具调用 hookId=${handler.id} tool=${payload.tool} reason=${result.reason}`);
				return { blocked: true, reason: result.reason, args, transforms };
			}
		}

		return { blocked: false, args, transforms };
	}

	/**
	 * 按事件（和可选类别）过滤 Handler 并按稳定优先级升序排序。
	 *
	 * @param event 事件名
	 * @param kind 可选类别过滤（transform/guard）
	 * @returns 排序后的 Handler 列表
	 */
	private orderedHandlers(event: HookEventName, kind?: HookHandlerKind): HookHandler[] {
		return [...this.handlers.values()]
			.filter((handler) => handler.event === event && (kind === undefined || handler.kind === kind))
			.sort((a, b) => a.priority - b.priority);
	}

	/**
	 * 执行单个 Handler：有界超时 + 异常捕获 + 耗时记录。
	 * 超时或异常返回 outcome=timeout/error 的轨迹，不向外抛出。
	 *
	 * @param handler 待执行的 Handler
	 * @param payload 事件载荷
	 * @returns 执行轨迹（与可用的 Handler 返回）
	 */
	private async runOne(handler: HookHandler, payload: HookPayload): Promise<HandlerRun> {
		const startedAt = Date.now();
		const sessionId = (payload as { sessionId?: string }).sessionId ?? 'none';
		const base = { event: handler.event, hookId: handler.id, startedAt };
		try {
			const result = await withTimeout(handler.handle(payload), handler.timeoutMs);
			const durationMs = Date.now() - startedAt;
			if (result === 'timeout') {
				logger.log(`[HookManager] Hook 执行超时已隔离 hookId=${handler.id} event=${handler.event} sessionId=${sessionId} 耗时=${handler.timeoutMs}ms`);
				return {
					trace: { ...base, durationMs, outcome: 'timeout', error: `执行超时（${handler.timeoutMs}ms）` },
				};
			}
			if (result.kind === 'transform' && handler.kind !== 'transform') {
				logger.log(`[HookManager] 非转换器返回 transform 结果，已忽略 hookId=${handler.id} event=${handler.event}`);
				return { trace: { ...base, durationMs, outcome: 'error', error: '非转换器返回了 transform 结果' } };
			}
			if (result.kind === 'block' && handler.kind !== 'guard') {
				logger.log(`[HookManager] 非守卫返回 block 结果，已忽略 hookId=${handler.id} event=${handler.event}`);
				return { trace: { ...base, durationMs, outcome: 'error', error: '非守卫返回了 block 结果' } };
			}
			logger.log(`[HookManager] Hook 执行完成 hookId=${handler.id} event=${handler.event} outcome=${result.kind} 耗时=${durationMs}ms sessionId=${sessionId}`);
			return { trace: { ...base, durationMs, outcome: result.kind }, result };
		} catch (error) {
			const durationMs = Date.now() - startedAt;
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`[HookManager] Hook 执行异常已隔离 hookId=${handler.id} event=${handler.event} sessionId=${sessionId} 耗时=${durationMs}ms error=${message}`);
			return { trace: { ...base, durationMs, outcome: 'error', error: message } };
		}
	}
}

/**
 * 带超时的 Promise 执行：超时返回 'timeout' 哨兵值，不向外抛出。
 * 定时器在 race 决出后清除，避免提前清除导致超时永不触发。
 *
 * @param promise 待执行的 Promise
 * @param timeoutMs 超时上限（毫秒）
 * @returns 原结果或 'timeout'
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), timeoutMs);
		}),
	]).finally(() => {
		if (timer) {
			clearTimeout(timer);
		}
	});
}
