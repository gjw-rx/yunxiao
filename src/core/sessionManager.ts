/**
 * 会话状态机 - 基于 v2 Run API 的计算与订阅分离架构。
 *
 * 流程：
 *   用户消息 -> createRun（POST，返回 run_id）
 *     subscribeRun（GET SSE）消费事件流：
 *       content/thought/tool_start/tool_end -> 转发 UI 展示
 *       run_status(interrupted) -> 标记中断，等待 tool_call 事件后 SSE 结束
 *       tool_call -> 收集本地工具调用
 *     SSE 结束（onEnd）-> 执行 pending 工具 -> submitRunToolResult -> 重新 subscribeRun 续流
 *     run_status(completed/failed/cancelled) -> 终态，轮次完成
 *
 * 取消：abort 当前流；为 pending 工具批量发 cancelled 结果。
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
import type { ToolContext } from '../tools/baseTool';
import { ToolTimeoutError, TransportError } from './errors';
import * as logger from '../logger';
import { ReliabilityMetrics } from './reliabilityMetrics';
import { RunStore, type StoredRun } from './runStore';

/** 会话管理器驱动的 v2 Run 客户端（由 AIClient 实现）。 */
export interface StreamClient {
	/** 创建持久化 Run。 */
	createRun(
		sessionId: string,
		text: string,
		clientRequestId: string,
	): Promise<{ run_id: string; session_id: string; status: string }>;
	/** 提交指定 Run 的本地工具结果，触发续算。返回 JSON（非 SSE）。 */
	submitRunToolResult(runId: string, results: ToolResult[]): Promise<void>;
	/** 从排他游标订阅持久化 Run 事件。onEnd 在 SSE 流正常结束时调用。 */
	subscribeRun(
		runId: string,
		afterSequence: number,
		onEvent: (event: { sequence: number | null; type: string; payload: unknown }) => void,
		onError: (error: Error) => void,
		onEnd: () => void,
	): AbortController;
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
	eventProcessing: Promise<void>;
	abortController?: AbortController;
	pendingToolCalls: ToolCall[];
	activeToolCalls: Map<string, ToolCall>;
	activeToolControllers: Map<string, AbortController>;
	finalizedCallIds: Set<string>;
	retryCounts: Map<string, number>;
	cancelled: boolean;
	running: boolean;
	pendingTerminalState?: 'completed' | 'failed' | 'cancelled';
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
		if (!state || !this.isCurrentRun(sessionId, state) || state.cancelled) {
			return;
		}
		state.abortController?.abort();

		state.cancelled = true;
		for (const controller of state.activeToolControllers.values()) {
			controller.abort();
		}
		state.eventProcessing = state.eventProcessing.then(() => {
			this.finishCancellation(sessionId, state);
		});
	}

	private finishCancellation(sessionId: string, state: SessionState): void {
		if (!this.isCurrentRun(sessionId, state)) {
			return;
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
			(event) => {
				this.enqueueEvent(
					run.sessionId,
					state,
					() => this.consumeStoredEvent(run.sessionId, state, event),
				);
			},
			(error) => this.finishRun(run.sessionId, state, 'disconnected', error.message),
			() => {
				void state.eventProcessing.then(() => {
					// 恢复模式不自动执行工具，仅在云端明确终态后结束本地 Run
					if (state.pendingTerminalState) {
						this.finishRun(run.sessionId, state, state.pendingTerminalState);
					}
				});
			},
		);
	}

	private async consumeStoredEvent(
		sessionId: string,
		state: SessionState,
		event: { sequence: number | null; type: string; payload: unknown },
	): Promise<void> {
		if (!this.isCurrentRun(sessionId, state) || !this.opts.runStore) {
			return;
		}
		if (event.type === 'run_status') {
			const data = readEventData(event.payload);
			const status = isRecord(data) && typeof data.status === 'string' ? data.status : '';
			if (status === 'completed' || status === 'failed' || status === 'cancelled') {
				state.pendingTerminalState = status;
			}
		}
		// content 按事件类型认定为瞬态，兼容旧服务错误返回 sequence=0。
		if (event.type === 'content' && event.sequence === 0) {
			this.dispatchRunEvent(sessionId, state, event);
			return;
		}
		// content 等瞬态事件 sequence 为 null，不持久化，直接转发
		if (event.sequence === null) {
			this.dispatchRunEvent(sessionId, state, event);
			return;
		}
		const result = await this.opts.runStore.append(sessionId, event);
		if (result.kind === 'gap') {
			state.abortController?.abort();
			this.sessions.delete(sessionId);
			this.restoreRun(result.run);
			return;
		}
		if (event.type === 'run_status') {
			this.handleRunStatus(sessionId, state, event.payload);
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
			eventProcessing: Promise.resolve(),
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
			(event) => {
				this.enqueueEvent(
					sessionId,
					state,
					() => this.consumeRunEvent(sessionId, state, event),
				);
			},
			(error) => this.finishRun(
				sessionId,
				state,
				error instanceof TransportError || error instanceof TypeError ? 'disconnected' : 'failed',
				error.message,
			),
			() => {
				// SSE 流结束前先等待已接收事件完成落盘和分发。
				void state.eventProcessing.then(() => this.handleStreamEnd(sessionId, state)).catch((err) => {
					logger.error('[SessionManager] handleStreamEnd 异常:', err instanceof Error ? err.stack ?? err.message : err);
					if (!this.isCurrentRun(sessionId, state)) {
						return;
					}
					const reason = err instanceof Error ? err.message : String(err);
					this.opts.eventBus.emit({ type: 'error', sessionId, payload: reason });
					this.finishRun(sessionId, state, 'failed', reason);
				});
			},
		);
		if (this.isCurrentRun(sessionId, state)) {
			state.abortController = controller;
			return;
		}
		controller.abort();
	}

	private enqueueEvent(
		sessionId: string,
		state: SessionState,
		consume: () => Promise<void>,
	): void {
		state.eventProcessing = state.eventProcessing
			.then(consume)
			.catch((error: unknown) => {
				if (!this.isCurrentRun(sessionId, state)) {
					return;
				}
				const reason = error instanceof Error ? error.message : String(error);
				logger.error(
					'# [SessionManager] Run 事件消费异常:',
					error instanceof Error ? error.stack ?? error.message : error,
				);
				this.opts.eventBus.emit({ type: 'error', sessionId, payload: reason });
				this.finishRun(sessionId, state, 'failed', reason);
			});
	}

	private async consumeRunEvent(
		sessionId: string,
		state: SessionState,
		event: { sequence: number | null; type: string; payload: unknown },
	): Promise<void> {
		if (!this.isCurrentRun(sessionId, state)) {
			return;
		}
		if (event.type === 'run_status') {
			const data = readEventData(event.payload);
			const status = isRecord(data) && typeof data.status === 'string' ? data.status : '';
			if (status === 'completed' || status === 'failed' || status === 'cancelled') {
				state.pendingTerminalState = status;
			}
		}
		// content 按事件类型认定为瞬态，兼容旧服务错误返回 sequence=0。
		if (event.type === 'content' && event.sequence === 0) {
			this.dispatchRunEvent(sessionId, state, event);
			return;
		}
		// content 等瞬态事件 sequence 为 null，跳过游标校验和持久化，直接分发
		if (event.sequence === null) {
			this.dispatchRunEvent(sessionId, state, event);
			return;
		}
		if (event.sequence <= state.cursor) {
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
			// 标记中断，等待 SSE 流结束（onEnd）再执行 pending 工具。
			// tool_call 事件在 run_status(interrupted) 之后到达，不能在此处驱动续流。
			void this.opts.runStore?.updateStatus(sessionId, 'interrupted');
			return;
		}
		if (status === 'completed' || status === 'failed' || status === 'cancelled') {
			void this.opts.runStore?.updateStatus(sessionId, status);
			state.pendingTerminalState = status;
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
		if (event.type === 'tool_start' && isRecord(data)) {
			// 云端工具：只读展示，由 run_id 配对 tool_end
			const callId = typeof data.tool_call_id === 'string' && data.tool_call_id
				? data.tool_call_id
				: `cloud:${data.run_id}`;
			this.opts.eventBus.emit({
				type: 'tool_state_change', sessionId, payload: {
					call_id: callId,
					state: 'running',
					tool: typeof data.name === 'string' ? data.name : '',
					args: data.input,
				}
			});
			return;
		}
		if (event.type === 'tool_end' && isRecord(data)) {
			const callId = typeof data.tool_call_id === 'string' && data.tool_call_id
				? data.tool_call_id
				: `cloud:${data.run_id}`;
			this.opts.eventBus.emit({
				type: 'tool_state_change', sessionId, payload: {
					call_id: callId,
					state: 'success',
					tool: typeof data.name === 'string' ? data.name : '',
					output: data.output,
				}
			});
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

	/** 流结束处理：有 pending 工具 -> 执行 + 续流；无 -> 轮次完成。 */
	private async handleStreamEnd(sessionId: string, state: SessionState): Promise<void> {
		if (!this.isCurrentRun(sessionId, state)) {
			return;
		}
		if (state.pendingToolCalls.length === 0) {
			this.finishRun(sessionId, state, state.pendingTerminalState ?? 'completed');
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
