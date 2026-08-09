/**
 * 内部事件总线 - 解耦 SSE 解析 / 工具执行 / 会话状态机 / UI。
 * 所有模块通过 EventBus 通信，UI 订阅事件更新界面。
 */

import * as logger from '../logger';

/** 事件类型。 */
export type EventType =
	| 'content'
	| 'thought'
	| 'step_end'
	| 'tool_call'
	| 'tool_result'
	| 'plan'
	| 'progress'
	| 'stream_end'
	| 'error'
	| 'tool_state_change'
	| 'run_state_change'
	| 'content_batch'
	| 'budget_update'
	| 'budget_exhausted'
	| 'token_usage'
	| 'session_token_usage';

/** 事件对象。 */
export interface AgentEvent {
	readonly type: EventType;
	readonly sessionId: string;
	readonly payload: unknown;
}

type Listener = (e: AgentEvent) => void;

/** 取消订阅函数。 */
export type Unsubscribe = () => void;

export class EventBus {
	private readonly listeners = new Map<EventType, Set<Listener>>();

	/** 订阅指定类型的事件，返回取消订阅函数。 */
	on(type: EventType, listener: Listener): Unsubscribe {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
		return () => {
			set?.delete(listener);
		};
	}

	/** 订阅所有事件类型（用于 UI 聚合订阅）。 */
	onAll(listener: Listener): Unsubscribe {
		const allTypes: EventType[] = [
			'content',
			'thought',
			'step_end',
			'tool_call',
			'tool_result',
			'plan',
			'progress',
			'stream_end',
			'error',
			'tool_state_change',
			'run_state_change',
			'content_batch',
			'budget_update',
			'budget_exhausted',
			'token_usage',
			'session_token_usage',
		];
		const unsubs = allTypes.map((t) => this.on(t, listener));
		return () => unsubs.forEach((u) => u());
	}

	/** 发射事件，通知所有该类型的订阅者。 */
	emit(event: AgentEvent): void {
		const set = this.listeners.get(event.type);
		if (!set) {
			return;
		}
		// 复制一份，避免回调中取消订阅导致迭代异常
		for (const listener of [...set]) {
			try {
				listener(event);
			} catch {
				// 单个监听器异常不影响其他监听器与事件流
			}
		}
	}

	/** 清空所有订阅（会话重置/销毁时调用）。 */
	clear(): void {
		logger.log('[EventBus] 清空所有订阅 count=' + this.listeners.size);
		this.listeners.clear();
	}
}
