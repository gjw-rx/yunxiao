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
import type { ToolCall, ToolResult, ToolLifecycleState } from './types';
import type { ToolRouter } from './toolRouter';
import type { EventBus, AgentEvent } from './eventBus';
import type { SseCallbacks } from '../protocol/sseHandler';
import type { ToolContext } from '../tools/baseTool';
import { ToolTimeoutError } from './errors';
import * as logger from '../logger';

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
	/** 按工具名获取自定义超时（毫秒），返回 undefined 则用默认 toolTimeoutMs。 */
	readonly getToolTimeoutMs?: (toolName: string) => number | undefined;
	/** 审批网关（可选，会话重置时清理其会话级允许记忆）。 */
	readonly approval?: { clearSession(sessionId: string): void };
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
	abortController?: AbortController;
	pendingToolCalls: ToolCall[];
	running: boolean;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const NOOP_CALLBACKS: SseCallbacks = {};

export class SessionManager {
	private readonly sessions = new Map<string, SessionState>();
	private readonly toolTimeoutMs: number;

	constructor(private readonly opts: SessionManagerOptions) {
		this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
	}

	/** 发起一次用户消息（开启新一轮 SSE 流）。 */
	sendMessage(sessionId: string, text: string): void {
		const state = this.getOrCreate(sessionId);
		state.pendingToolCalls = [];
		state.running = true;
		this.startMessageStream(sessionId, text);
	}

	/** 取消当前轮次：abort 流 + 为 pending 工具发 cancelled 结果。 */
	cancel(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (!state) {
			return;
		}
		state.abortController?.abort();

		// 为已收集的 pending 工具批量发 cancelled 结果（回调置空，忽略续流）
		if (state.pendingToolCalls.length > 0) {
			const results: ToolResult[] = state.pendingToolCalls.map((call) => {
				this.emitToolState(sessionId, call, 'error', 'user cancelled');
				return { call_id: call.call_id, status: 'cancelled', error: 'user cancelled' };
			});
			this.opts.client.submitToolResult(results, sessionId, NOOP_CALLBACKS);
		}
		state.pendingToolCalls = [];
		state.running = false;
		state.abortController = undefined;
		this.opts.eventBus.emit({ type: 'stream_end', sessionId, payload: null });
	}

	/** 重置/清理会话状态。 */
	reset(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		state?.abortController?.abort();
		this.sessions.delete(sessionId);
		this.opts.approval?.clearSession(sessionId);
	}

	private getOrCreate(sessionId: string): SessionState {
		let state = this.sessions.get(sessionId);
		if (!state) {
			state = { pendingToolCalls: [], running: false };
			this.sessions.set(sessionId, state);
		}
		return state;
	}

	private startMessageStream(sessionId: string, text: string): void {
		const state = this.getOrCreate(sessionId);
		state.pendingToolCalls = [];
		const cbs = this.makeCallbacks(sessionId);
		state.abortController = this.opts.client.streamMessage(sessionId, text, cbs);
	}

	private startContinuationStream(sessionId: string, results: ToolResult[]): void {
		const state = this.getOrCreate(sessionId);
		state.pendingToolCalls = [];
		const cbs = this.makeCallbacks(sessionId);
		state.abortController = this.opts.client.submitToolResult(results, sessionId, cbs);
	}

	/** 构造一轮 SSE 流的回调：转发事件到事件总线，收集 tool_call，结束时驱动续流。 */
	private makeCallbacks(sessionId: string): SseCallbacks {
		const state = this.getOrCreate(sessionId);
		const emit = (type: AgentEvent['type'], payload: unknown): void => {
			this.opts.eventBus.emit({ type, sessionId, payload });
		};
		return {
			onContent: (t) => emit('content', t),
			onThought: (t) => emit('thought', t),
			onToolStart: (name) => emit('tool_call', name),
			onToolEnd: (output) => emit('tool_result', output),
			onToolCall: (e) => {
				const call: ToolCall = { ...e };
				state.pendingToolCalls.push(call);
				this.emitToolState(sessionId, call, 'pending');
			},
			onPlan: (e) => emit('plan', e),
			onProgress: (e) => emit('progress', e),
			onError: (err) => {
				emit('error', err.message);
				state.running = false;
				state.abortController = undefined;
				emit('stream_end', null);
			},
			onEnd: () => {
				this.handleStreamEnd(sessionId).catch((err) => {
					logger.error('[SessionManager] handleStreamEnd 异常:', err instanceof Error ? err.stack ?? err.message : err);
				});
			},
		};
	}

	/** 流结束处理：有 pending 工具 -> 执行 + 续流；无 -> 轮次完成。 */
	private async handleStreamEnd(sessionId: string): Promise<void> {
		const state = this.getOrCreate(sessionId);

		if (state.pendingToolCalls.length === 0) {
			state.running = false;
			state.abortController = undefined;
			this.opts.eventBus.emit({ type: 'stream_end', sessionId, payload: null });
			return;
		}

		// Phase 3：并行执行全部 pending 工具，收集结果后批量续流
		const calls = state.pendingToolCalls.splice(0);
		for (const call of calls) {
			this.emitToolState(sessionId, call, 'running');
		}
		const results = await Promise.all(
			calls.map(async (call): Promise<ToolResult> => {
				try {
					const r = await this.executeWithTimeout(sessionId, call);
					this.emitToolState(
						sessionId,
						call,
						r.status === 'success' ? 'success' : 'error',
						r.error,
						r.result
					);
					return r;
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					this.emitToolState(sessionId, call, 'error', reason);
					return { call_id: call.call_id, status: 'error', error: reason };
				}
			})
		);

		for (const result of results) {
			this.opts.eventBus.emit({ type: 'tool_result', sessionId, payload: result });
		}

		// 续流：批量提交结果 -> 新一轮 SSE 流
		this.startContinuationStream(sessionId, results);
	}

	/** 带超时地执行工具（超时则发 error；底层工具 promise 被遗弃）。 */
	private executeWithTimeout(sessionId: string, call: ToolCall): Promise<ToolResult> {
		const effectiveTimeout = this.opts.getToolTimeoutMs?.(call.tool) ?? this.toolTimeoutMs;
		const context: ToolContext = {
			workspaceRoots: this.opts.getWorkspaceRoots(),
			maxFileSize: this.opts.getMaxFileSize?.(),
			toolTimeoutMs: effectiveTimeout,
			sessionId,
			warn: (m) => this.opts.eventBus.emit({ type: 'error', sessionId, payload: m }),
			terminalOutputLimit: this.opts.getTerminalOutputLimit?.(),
		};
		return new Promise<ToolResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new ToolTimeoutError(call.tool, effectiveTimeout));
			}, effectiveTimeout);
			this.opts.router
				.route(call, context)
				.then((r) => {
					clearTimeout(timer);
					resolve(r);
				})
				.catch((e) => {
					clearTimeout(timer);
					reject(e);
				});
		});
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
