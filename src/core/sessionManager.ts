/**
 * 会话状态机 - 协调一次用户输入触发的多轮 SSE 流（每轮可能含一个本地工具调用）。
 *
 * 流程：
 *   用户消息 -> streamMessage（SSE 流 A）
 *     流 A 收集 tool_call，结束后执行工具 -> submitToolResult（SSE 续流 B）
 *       流 B 可能再次出现 tool_call -> 续流 C ...
 *       流 B 以 content 结束且无 tool_call -> 轮次完成
 *
 * Phase 1 约定：每轮 SSE 流至多一个 tool_call（批量并行 tool_call_batch 留待后续阶段）。
 * 取消：abort 当前流；为 pending 工具发 cancelled 结果（回调置空，忽略续流）。
 * 超时：工具执行超过 toolTimeoutMs 则发 error 结果。
 */
import type { ToolCall, ToolResult, ToolLifecycleState } from './types';
import type { ToolRouter } from './toolRouter';
import type { EventBus, AgentEvent } from './eventBus';
import type { SseCallbacks } from '../protocol/sseHandler';
import type { ToolContext } from '../tools/baseTool';
import { ToolTimeoutError } from './errors';

/** 会话管理器驱动的流客户端（由 AIClient 实现）。 */
export interface StreamClient {
	/** 发起用户消息 SSE 流。 */
	streamMessage(sessionId: string, text: string, callbacks: SseCallbacks): AbortController;
	/** 提交工具结果并读取 SSE 续流。 */
	submitToolResult(result: ToolResult, sessionId: string, callbacks: SseCallbacks): AbortController;
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
	/** 审批网关（可选，会话重置时清理其会话级允许记忆）。 */
	readonly approval?: { clearSession(sessionId: string): void };
}

/** 工具状态变更事件 payload。 */
export interface ToolStateChangePayload {
	readonly call_id: string;
	readonly state: ToolLifecycleState;
	readonly tool: string;
	readonly error?: string;
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

		// 为已收集的 pending 工具发 cancelled 结果（回调置空，忽略续流）
		for (const call of state.pendingToolCalls) {
			this.emitToolState(sessionId, call, 'error', 'user cancelled');
			this.opts.client.submitToolResult(
				{ call_id: call.call_id, status: 'cancelled', error: 'user cancelled' },
				sessionId,
				NOOP_CALLBACKS
			);
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

	private startContinuationStream(sessionId: string, result: ToolResult): void {
		const state = this.getOrCreate(sessionId);
		state.pendingToolCalls = [];
		const cbs = this.makeCallbacks(sessionId);
		state.abortController = this.opts.client.submitToolResult(result, sessionId, cbs);
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
				void this.handleStreamEnd(sessionId);
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

		// Phase 1：每轮处理首个 tool_call；其余视为不支持，发 cancelled
		const call = state.pendingToolCalls.shift() as ToolCall;
		const extras = state.pendingToolCalls.splice(0);
		for (const ex of extras) {
			this.emitToolState(sessionId, ex, 'error', 'batch not supported in Phase 1');
			this.opts.client.submitToolResult(
				{ call_id: ex.call_id, status: 'cancelled', error: 'batch not supported in Phase 1' },
				sessionId,
				NOOP_CALLBACKS
			);
		}

		// 执行工具（带超时）
		this.emitToolState(sessionId, call, 'running');
		let result: ToolResult;
		try {
			result = await this.executeWithTimeout(sessionId, call);
			this.emitToolState(sessionId, call, result.status === 'success' ? 'success' : 'error');
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			result = { call_id: call.call_id, status: 'error', error: reason };
			this.emitToolState(sessionId, call, 'error', reason);
		}

		this.opts.eventBus.emit({ type: 'tool_result', sessionId, payload: result });

		// 续流：提交结果 -> 新一轮 SSE 流
		this.startContinuationStream(sessionId, result);
	}

	/** 带超时地执行工具（超时则发 error；底层工具 promise 被遗弃）。 */
	private executeWithTimeout(sessionId: string, call: ToolCall): Promise<ToolResult> {
		const context: ToolContext = {
			workspaceRoots: this.opts.getWorkspaceRoots(),
			maxFileSize: this.opts.getMaxFileSize?.(),
			toolTimeoutMs: this.toolTimeoutMs,
			sessionId,
			warn: (m) => this.opts.eventBus.emit({ type: 'error', sessionId, payload: m }),
		};
		return new Promise<ToolResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new ToolTimeoutError(call.tool, this.toolTimeoutMs));
			}, this.toolTimeoutMs);
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
		error?: string
	): void {
		const payload: ToolStateChangePayload = {
			call_id: call.call_id,
			state,
			tool: call.tool,
			error,
		};
		this.opts.eventBus.emit({ type: 'tool_state_change', sessionId, payload });
	}
}
