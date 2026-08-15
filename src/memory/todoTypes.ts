/**
 * 会话任务状态契约 - 定义模型任务清单的持久化、事件与 Webview 共享数据结构。
 */

/** 任务执行状态。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** 单条有序任务。 */
export interface TodoItem {
	/** 模型在同一任务计划中保持稳定的唯一标识。 */
	readonly id: string;
	/** 面向用户和模型的简短任务说明。 */
	readonly content: string;
	/** 当前执行状态。 */
	readonly status: TodoStatus;
}

/** 会话的完整任务快照。 */
export interface TodoSnapshot {
	/** 按执行优先级排序的任务。 */
	readonly todos: readonly TodoItem[];
}

/** 任务状态计数。 */
export interface TodoSummary {
	/** 任务总数。 */
	readonly total: number;
	/** 待办数量。 */
	readonly pending: number;
	/** 进行中数量。 */
	readonly in_progress: number;
	/** 已完成数量。 */
	readonly completed: number;
	/** 已取消数量。 */
	readonly cancelled: number;
}

/** 计算任务快照的状态统计。 @param snapshot 任务快照。 @returns 状态统计。 */
export interface TodoStateUpdate {
	readonly snapshot: TodoSnapshot;
	readonly summary: TodoSummary;
}

export function summarizeTodos(snapshot: TodoSnapshot): TodoSummary {
	const summary = { total: snapshot.todos.length, pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
	for (const todo of snapshot.todos) {
		summary[todo.status]++;
	}
	return summary;
}
