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
import { ToolTimeoutError, TransportError } from './errors';
import * as logger from '../logger';
import { ReliabilityMetrics } from './reliabilityMetrics';
import { RunStore, type StoredRun } from './runStore';

/** 会话管理器驱动的流客户端（由 AIClient 实现）。 */
export interface StreamClient {
	/** 创建持久化 Run。 */
	createRun(
		sessionId: string,
		text: string,
		clientRequestId: string,
	): Promise<{ run_id: string; session_id: string; status: string }>;
	/** 提交指定 Run 的本地工具结果。 */
	submitRunToolResult(runId: string, results: ToolResult[]): Promise<void>;
	/** 从排他游标订阅持久化 Run。 */
	subscribeRun(
		runId: string,
		afterSequence: number,
		onEvent: (event: { sequence: number; type: string; payload: unknown }) => void,
		onError: (error: Error) => void,
	): AbortController;
	/** 发起用户消息 SSE 流。 */
	streamMessage(sessionId: string, text: string, callbacks: SseCallbacks): AbortController;
	/** 批量提交工具结果并读取 SSE 续流。 */
	submitToolResult(results: ToolResult[], sessionId: string, callbacks: SseCallbacks): AbortController;
	/** 订阅持久化 Run；旧客户端不实现时不会启用恢复。 */
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
	/** 工作区 Run 快照，用于扩展宿主重启后的只读恢复。 */
	readonly runStore?: RunStore;
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
	runId?: string;
	cursor: number;
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
		void this.startRun(sessionId, text, state);
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
		if (results.length > 0 && state.runId) {
			this.opts.metrics?.record('tool_cancelled');
			void this.opts.client.submitRunToolResult(state.runId, results);
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
		for (const controller of state?.activeToolControllers.values() ?? []) {
			controller.abort();
		}
		this.sessions.delete(sessionId);
		this.opts.approval?.clearSession(sessionId);
		void this.opts.runStore?.remove(sessionId);
	}

	/** 恢复云端未终态 Run；已持久化的工具调用绝不在恢复时自动执行。 */
	restoreRun(run: StoredRun): void {
		if (this.sessions.has(run.sessionId)) {
			return;
		}
		const state = this.createState();
		state.runId = run.runId;
		state.cursor = run.cursor;
		this.sessions.set(run.sessionId, state);
		for (const event of run.events) {
			if (isAgentEventType(event.type)) {
				this.opts.eventBus.emit({ type: event.type, sessionId: run.sessionId, payload: event.payload });
			}
		}
		state.abortController = this.opts.client.subscribeRun(
			run.runId,
			run.cursor,
			(event) => { void this.consumeStoredEvent(run.sessionId, state, event); },
			(error) => this.finishRun(run.sessionId, state, 'disconnected', error.message),
		);
	}

	private async consumeStoredEvent(
		sessionId: string,
		state: SessionState,
		event: { sequence: number; type: string; payload: unknown },
	): Promise<void> {
		if (!this.isCurrentRun(sessionId, state) || !this.opts.runStore) {
			return;
		}
		const result = await this.opts.runStore.append(sessionId, event);
		if (result.kind === 'gap') {
			state.abortController?.abort();
			this.sessions.delete(sessionId);
			this.restoreRun(result.run);
			return;
		}
		if (result.kind === 'appended' && isAgentEventType(event.type)) {
			this.opts.eventBus.emit({ type: event.type, sessionId, payload: event.payload });
		}
	}

	private createState(): SessionState {
		return {
			generation: ++this.nextGeneration,
			cursor: 0,
			pendingToolCalls: [],
			activeToolCalls: new Map(),
			activeToolControllers: new Map(),
			finalizedCallIds: new Set(),
			retryCounts: new Map(),
			cancelled: false,
			running: true,
		};
	}

	private async startRun(sessionId: string, text: string, state: SessionState): Promise<void> {
		try {
			const run = await this.opts.client.createRun(
				sessionId,
				text,
				`${sessionId}-${state.generation}-${Date.now()}`,
			);
			if (!this.isCurrentRun(sessionId, state)) {
				return;
			}
			state.runId = run.run_id;
			await this.opts.runStore?.save({
				sessionId,
				runId: run.run_id,
				cursor: 0,
				status: 'running',
				workspaceRoots: this.opts.getWorkspaceRoots(),
				events: [],
				timeline: [],
			});
			this.startRunSubscription(sessionId, state);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.finishRun(sessionId, state, 'failed', reason);
		}
	}

	private startContinuationStream(
		sessionId: string,
		results: ToolResult[],
		state: SessionState
	): void {
		if (!this.isCurrentRun(sessionId, state)) {
			return;
		}
		if (!state.runId) {
			this.finishRun(sessionId, state, 'failed', 'Run ID 缺失');
			return;
		}
		state.pendingToolCalls = [];
		state.abortController?.abort();
		void this.opts.client.submitRunToolResult(state.runId, results)
			.then(() => {
				if (this.isCurrentRun(sessionId, state)) {
					this.startRunSubscription(sessionId, state);
				}
			})
			.catch((error: Error) => {
				this.finishRun(sessionId, state, 'failed', error.message);
			});
	}

	private startRunSubscription(sessionId: string, state: SessionState): void {
		if (!state.runId || !this.isCurrentRun(sessionId, state)) {
			return;
		}
		const controller = this.opts.client.subscribeRun(
			state.runId,
			state.cursor,
			(event) => { void this.consumeRunEvent(sessionId, state, event); },
			(error) => this.finishRun(
				sessionId,
				state,
				error instanceof TransportError || error instanceof TypeError ? 'disconnected' : 'failed',
				error.message,
			),
		);
		if (this.isCurrentRun(sessionId, state)) {
			state.abortController = controller;
			return;
		}
		controller.abort();
	}

	private async consumeRunEvent(
		sessionId: string,
		state: SessionState,
		event: { sequence: number; type: string; payload: unknown },
	): Promise<void> {
		if (!this.isCurrentRun(sessionId, state) || event.sequence <= state.cursor) {
			return;
		}
		if (event.sequence !== state.cursor + 1) {
			this.finishRun(sessionId, state, 'disconnected', 'Run 事件序号不连续');
			return;
		}
		state.cursor = event.sequence;
		if (this.opts.runStore) {
			const result = await this.opts.runStore.append(sessionId, event);
			if (result.kind === 'gap') {
				this.finishRun(sessionId, state, 'disconnected', 'Run 事件序号不连续');
				return;
			}
		}
		if (event.type === 'run_status') {
			this.handleRunStatus(sessionId, state, event.payload);
			return;
		}
		this.dispatchRunEvent(sessionId, state, event);
	}

	private handleRunStatus(sessionId: string, state: SessionState, payload: unknown): void {
		const data = readEventData(payload);
		const status = isRecord(data) && typeof data.status === 'string' ? data.status : '';
		if (status === 'interrupted') {
			void this.opts.runStore?.updateStatus(sessionId, 'interrupted');
			this.handleStreamEnd(sessionId, state).catch((error) => {
				const reason = error instanceof Error ? error.message : String(error);
				this.finishRun(sessionId, state, 'failed', reason);
			});
			return;
		}
		if (status === 'completed' || status === 'failed' || status === 'cancelled') {
			void this.opts.runStore?.updateStatus(sessionId, status);
			this.finishRun(sessionId, state, status);
		}
	}

	private dispatchRunEvent(
		sessionId: string,
		state: SessionState,
		event: { type: string; payload: unknown },
	): void {
		const data = readEventData(event.payload);
		if (event.type === 'content' && typeof data === 'string') {
			this.opts.eventBus.emit({ type: 'content', sessionId, payload: data });
			return;
		}
		if (event.type === 'thought' && typeof data === 'string') {
			this.opts.eventBus.emit({ type: 'thought', sessionId, payload: data });
			return;
		}
		if (event.type === 'tool_call' && Array.isArray(data)) {
			for (const item of data) {
				if (!isToolCall(item)) {
					continue;
				}
				state.pendingToolCalls.push(item);
				this.emitToolState(sessionId, item, 'pending');
			}
			return;
		}
		if (event.type === 'plan' || event.type === 'progress') {
			this.opts.eventBus.emit({ type: event.type, sessionId, payload: data });
		}
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
					err instanceof TypeError || err instanceof TransportError ? 'disconnected' : 'failed',
					err.message
				);
			},
			onDuplicateAcknowledged: () => {
				if (!this.isCurrentRun(sessionId, state)) {
					return;
				}
				this.finishRun(sessionId, state, 'disconnected');
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
			runId: state.runId,
			warn: (m) => {
				if (this.isCurrentRun(sessionId, state)) {
					this.opts.eventBus.emit({ type: 'error', sessionId, payload: m });
				}
			},
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

function isAgentEventType(type: string): type is AgentEvent['type'] {
	return ['content', 'content_batch', 'thought', 'tool_call', 'tool_result', 'plan', 'progress', 'stream_end', 'error', 'tool_state_change', 'run_state_change', 'budget_update', 'budget_exhausted'].includes(type);
}

function readEventData(payload: unknown): unknown {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	return (payload as { data?: unknown }).data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isToolCall(value: unknown): value is ToolCall {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const call = value as Partial<ToolCall>;
	return typeof call.call_id === 'string'
		&& typeof call.tool === 'string'
		&& call.args !== undefined
		&& typeof call.args === 'object';
}
