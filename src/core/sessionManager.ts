/**
 * 会话状态机 - 协调一次用户输入触发的多轮 SSE 流（每轮可能含一个本地工具调用）。
 *
 * 流程：
 *   用户消息 -> streamMessage（SSE 流 A）
 *     流 A 收集 tool_call，结束后执行工具 -> submitToolResult（SSE 续流 B）
 *       流 B 可能再次出现 tool_call -> 续流 C ...
 *       流 B 以 content 结束且无 tool_call -> 轮次完成
 *
 * Phase 3：每轮 SSE 流可含多个 tool_call（data 为数组），并行执行后批量回传结果。
 * 取消：abort 当前流；为 pending 工具批量发 cancelled 结果（回调置空，忽略续流）。
 * 超时：工具执行超过 toolTimeoutMs 则发 error 结果。
 */
import type {
	RunLifecycleState,
	RunStateChangePayload,
	ToolCall,
	ToolResult,
	ToolLifecycleState,
} from './types';
import type { ToolRouter } from './toolRouter';
import type { EventBus, AgentEvent } from './eventBus';
import type { SseCallbacks } from '../protocol/sseHandler';
import type { ToolContext } from '../tools/baseTool';
import { ToolTimeoutError } from './errors';
import * as logger from '../logger';
import { ReliabilityMetrics } from './reliabilityMetrics';

/** 会话管理器驱动的流客户端（由 AIClient 实现）。 */
export interface StreamClient {
	/** 发起用户消息 SSE 流。 */
	streamMessage(sessionId: string, text: string, callbacks: SseCallbacks): AbortController;
	/** 批量提交工具结果并读取 SSE 续流。 */
	submitToolResult(results: ToolResult[], sessionId: string, callbacks: SseCallbacks): AbortController;
}

export interface SessionManagerOptions {
	readonly client: StreamClient;
	readonly router: ToolRouter;
	readonly eventBus: EventBus;
	/** 工具执行超时（毫秒），默认 30000。 */
	readonly toolTimeoutMs?: number;
	/** 获取工作区根列表（运行时读取，工作区可变）。 */
	readonly getWorkspaceRoots: () => string[];
	/** 获取读文件大小上限。 */
	readonly getMaxFileSize?: () => number | undefined;
	/** 获取终端输出截断上限。 */
	readonly getTerminalOutputLimit?: () => number | undefined;
	/** 获取所有工具回传云端前的统一文本长度上限。 */
	readonly getToolResultLimit?: () => number | undefined;
	/** 按工具名获取自定义超时（毫秒），返回 undefined 则用默认 toolTimeoutMs。 */
	readonly getToolTimeoutMs?: (toolName: string) => number | undefined;
	/** 审批网关（可选，会话重置时清理其会话级允许记忆）。 */
	readonly approval?: { clearSession(sessionId: string): void };
	/** 本地安全与可靠性计数器。 */
	readonly metrics?: ReliabilityMetrics;
}

/** 工具状态变更事件 payload。 */
export interface ToolStateChangePayload {
	readonly call_id: string;
	readonly state: ToolLifecycleState;
	readonly tool: string;
	readonly error?: string;
	/** 工具入参，供 UI 展示本轮调用了什么。 */
	readonly args?: unknown;
	/** 工具产出，仅在终态（success/error）携带。 */
	readonly output?: unknown;
}

interface SessionState {
	readonly generation: number;
	abortController?: AbortController;
	pendingToolCalls: ToolCall[];
	activeToolCalls: Map<string, ToolCall>;
	activeToolControllers: Map<string, AbortController>;
	finalizedCallIds: Set<string>;
	retryCounts: Map<string, number>;
	cancelled: boolean;
	running: boolean;
	terminalState?: Exclude<RunLifecycleState, 'running'>;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const NOOP_CALLBACKS: SseCallbacks = {};

export class SessionManager {
	private readonly sessions = new Map<string, SessionState>();
	private readonly toolTimeoutMs: number;
	private nextGeneration = 0;

	constructor(private readonly opts: SessionManagerOptions) {
		this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
	}

	/** 发起一次用户消息（开启新一轮 SSE 流）。 */
	sendMessage(sessionId: string, text: string): void {
		const previous = this.sessions.get(sessionId);
		previous?.abortController?.abort();
		for (const controller of previous?.activeToolControllers.values() ?? []) {
			controller.abort();
		}
		const state = this.createState();
		this.sessions.set(sessionId, state);
		this.emitRunState(sessionId, state, 'running');
		this.startMessageStream(sessionId, text, state);
	}

	/** 取消当前轮次：abort 流 + 为 pending 工具发 cancelled 结果。 */
	cancel(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (!state || !this.isCurrentRun(sessionId, state)) {
			return;
		}
		state.abortController?.abort();

		state.cancelled = true;
		for (const controller of state.activeToolControllers.values()) {
			controller.abort();
		}

		// pending 与 running 调用均只终结一次；回调置空，忽略取消后的续流。
		const calls = new Map<string, ToolCall>();
		for (const call of state.pendingToolCalls) {
			calls.set(call.call_id, call);
		}
		for (const [id, call] of state.activeToolCalls) {
			calls.set(id, call);
		}
		const results: ToolResult[] = [];
		for (const call of calls.values()) {
			if (!this.finalizeCall(state, call.call_id)) {
				continue;
			}
			this.emitToolState(sessionId, call, 'cancelled', '用户取消执行');
			results.push({ call_id: call.call_id, status: 'cancelled', error: '用户取消执行' });
		}
		if (results.length > 0) {
			this.opts.metrics?.record('tool_cancelled');
			this.opts.client.submitToolResult(results, sessionId, NOOP_CALLBACKS);
		}
		state.pendingToolCalls = [];
		state.activeToolCalls.clear();
		state.activeToolControllers.clear();
		this.finishRun(sessionId, state, 'cancelled');
	}

	/** 重置/清理会话状态。 */
	reset(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		state?.abortController?.abort();
		this.sessions.delete(sessionId);
		this.opts.approval?.clearSession(sessionId);
	}

	private createState(): SessionState {
		return {
			generation: ++this.nextGeneration,
			pendingToolCalls: [],
			activeToolCalls: new Map(),
			activeToolControllers: new Map(),
			finalizedCallIds: new Set(),
			retryCounts: new Map(),
			cancelled: false,
			running: true,
		};
	}

	private startMessageStream(sessionId: string, text: string, state: SessionState): void {
		state.pendingToolCalls = [];
		const controller = this.opts.client.streamMessage(
			sessionId,
			text,
			this.makeCallbacks(sessionId, state)
		);
		if (this.isCurrentRun(sessionId, state)) {
			state.abortController = controller;
			return;
		}
		controller.abort();
	}

	private startContinuationStream(
		sessionId: string,
		results: ToolResult[],
		state: SessionState
	): void {
		if (!this.isCurrentRun(sessionId, state)) {
			return;
		}
		state.pendingToolCalls = [];
		const controller = this.opts.client.submitToolResult(
			results,
			sessionId,
			this.makeCallbacks(sessionId, state)
		);
		if (this.isCurrentRun(sessionId, state)) {
			state.abortController = controller;
			return;
		}
		controller.abort();
	}

	/** 构造一轮 SSE 流的回调：转发事件到事件总线，收集 tool_call，结束时驱动续流。 */
	private makeCallbacks(sessionId: string, state: SessionState): SseCallbacks {
		const emit = (type: AgentEvent['type'], payload: unknown): void => {
			if (!this.isCurrentRun(sessionId, state)) {
				return;
			}
			this.opts.eventBus.emit({ type, sessionId, payload });
		};
		return {
			onContent: (t) => emit('content', t),
			onThought: (t) => emit('thought', t),
			onToolStart: (data) => emit('tool_state_change', {
				call_id: data.run_id,
				state: 'running',
				tool: data.name,
				args: data.input,
			}),
			onToolEnd: (data) => emit('tool_state_change', {
				call_id: data.run_id,
				state: 'success',
				tool: data.name,
				output: data.output,
			}),
			onToolCall: (e) => {
				if (!this.isCurrentRun(sessionId, state)) {
					return;
				}
				const call: ToolCall = { ...e };
				state.pendingToolCalls.push(call);
				this.emitToolState(sessionId, call, 'pending');
			},
			onPlan: (e) => emit('plan', e),
			onProgress: (e) => emit('progress', e),
			onError: (err) => {
				if (!this.isCurrentRun(sessionId, state)) {
					return;
				}
				emit('error', err.message);
				this.finishRun(
					sessionId,
					state,
					err instanceof TypeError ? 'disconnected' : 'failed',
					err.message
				);
			},
			onEnd: () => {
				if (!this.isCurrentRun(sessionId, state)) {
					return;
				}
				this.handleStreamEnd(sessionId, state).catch((err) => {
					logger.error('[SessionManager] handleStreamEnd 异常:', err instanceof Error ? err.stack ?? err.message : err);
					if (!this.isCurrentRun(sessionId, state)) {
						return;
					}
					const reason = err instanceof Error ? err.message : String(err);
					this.opts.eventBus.emit({ type: 'error', sessionId, payload: reason });
					this.finishRun(sessionId, state, 'failed', reason);
				});
			},
		};
	}

	/** 流结束处理：有 pending 工具 -> 执行 + 续流；无 -> 轮次完成。 */
	private async handleStreamEnd(sessionId: string, state: SessionState): Promise<void> {
		if (!this.isCurrentRun(sessionId, state)) {
			return;
		}
		if (state.pendingToolCalls.length === 0) {
			this.finishRun(sessionId, state, 'completed');
			return;
		}

		// 默认顺序执行；仅在后续明确声明 canParallel 且无资源冲突时再开放并行。
		const calls = state.pendingToolCalls.splice(0);
		const runCall = async (call: ToolCall): Promise<ToolResult | undefined> => {
			if (
				!this.isCurrentRun(sessionId, state)
				|| state.cancelled
				|| state.finalizedCallIds.has(call.call_id)
			) {
				return undefined;
			}
			this.emitToolState(sessionId, call, 'running');
			try {
				const r = await this.executeWithTimeout(sessionId, call, state);
				if (
					!this.isCurrentRun(sessionId, state)
					|| state.cancelled
					|| !this.finalizeCall(state, call.call_id)
				) {
					return undefined;
				}
					this.emitToolState(
						sessionId,
						call,
						r.status === 'success' ? 'success' : 'error',
						r.error,
						r.result
					);
					return r;
			} catch (err) {
				if (
					!this.isCurrentRun(sessionId, state)
					|| state.cancelled
					|| !this.finalizeCall(state, call.call_id)
				) {
					return undefined;
				}
					const reason = err instanceof Error ? err.message : String(err);
					this.emitToolState(sessionId, call, 'error', reason);
					return { call_id: call.call_id, status: 'error', error: reason, metadata: { retryable: false } };
				}
		};
		const parallel = calls.length > 1 && calls.every((call) => this.opts.router.canRunInParallel(call));
		if (parallel) {
			this.opts.metrics?.record('parallel_tool_batch');
		}
		const completed = parallel ? await Promise.all(calls.map(runCall)) : await runSequential(calls, runCall);
		const results = completed.filter((result): result is ToolResult => result !== undefined);

		if (!this.isCurrentRun(sessionId, state) || state.cancelled || results.length === 0) {
			return;
		}

		for (const result of results) {
			this.opts.eventBus.emit({ type: 'tool_result', sessionId, payload: result });
		}

		// 续流：批量提交结果 -> 新一轮 SSE 流
		this.startContinuationStream(sessionId, results, state);
	}

	/** 带超时地执行工具（超时则发 error；底层工具 promise 被遗弃）。 */
	private executeWithTimeout(
		sessionId: string,
		call: ToolCall,
		state: SessionState
	): Promise<ToolResult> {
		const effectiveTimeout = this.opts.getToolTimeoutMs?.(call.tool) ?? this.toolTimeoutMs;
		const controller = new AbortController();
		state.activeToolCalls.set(call.call_id, call);
		state.activeToolControllers.set(call.call_id, controller);
		const context: ToolContext = {
			workspaceRoots: this.opts.getWorkspaceRoots(),
			maxFileSize: this.opts.getMaxFileSize?.(),
			toolTimeoutMs: effectiveTimeout,
			sessionId,
			warn: (m) => this.opts.eventBus.emit({ type: 'error', sessionId, payload: m }),
			terminalOutputLimit: this.opts.getTerminalOutputLimit?.(),
			toolResultLimit: this.opts.getToolResultLimit?.(),
			abortSignal: controller.signal,
		};
		return new Promise<ToolResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				controller.abort();
				this.opts.metrics?.record('tool_timeout');
				reject(new ToolTimeoutError(call.tool, effectiveTimeout));
			}, effectiveTimeout);
			this.opts.router
				.route(call, context)
				.then((r) => {
					clearTimeout(timer);
					state.activeToolCalls.delete(call.call_id);
					state.activeToolControllers.delete(call.call_id);
					resolve(r);
				})
				.catch((e) => {
					clearTimeout(timer);
					state.activeToolCalls.delete(call.call_id);
					state.activeToolControllers.delete(call.call_id);
					reject(e);
				});
		});
	}

	private finalizeCall(state: SessionState, callId: string): boolean {
		if (state.finalizedCallIds.has(callId)) {
			this.opts.metrics?.record('duplicate_result_ignored');
			return false;
		}
		state.finalizedCallIds.add(callId);
		return true;
	}

	private isCurrentRun(sessionId: string, state: SessionState): boolean {
		return (
			this.sessions.get(sessionId) === state
			&& state.running
			&& state.terminalState === undefined
		);
	}

	private finishRun(
		sessionId: string,
		state: SessionState,
		terminalState: Exclude<RunLifecycleState, 'running'>,
		error?: string
	): boolean {
		if (!this.isCurrentRun(sessionId, state)) {
			return false;
		}
		state.terminalState = terminalState;
		state.running = false;
		state.abortController = undefined;
		this.emitRunState(sessionId, state, terminalState, error);
		this.opts.eventBus.emit({ type: 'stream_end', sessionId, payload: null });
		return true;
	}

	private emitRunState(
		sessionId: string,
		state: SessionState,
		runState: RunLifecycleState,
		error?: string
	): void {
		const payload: RunStateChangePayload = {
			generation: state.generation,
			state: runState,
			error,
		};
		this.opts.eventBus.emit({ type: 'run_state_change', sessionId, payload });
	}

	private emitToolState(
		sessionId: string,
		call: ToolCall,
		state: ToolLifecycleState,
		error?: string,
		output?: unknown
	): void {
		const payload: ToolStateChangePayload = {
			call_id: call.call_id,
			state,
			tool: call.tool,
			error,
			args: call.args,
			output,
		};
		this.opts.eventBus.emit({ type: 'tool_state_change', sessionId, payload });
	}
}

async function runSequential<T>(
	items: readonly T[],
	run: (item: T) => Promise<ToolResult | undefined>
): Promise<(ToolResult | undefined)[]> {
	const results: (ToolResult | undefined)[] = [];
	for (const item of items) {
		results.push(await run(item));
	}
	return results;
}
