/**
 * 会话任务面板 - 只读展示模型通过 todo_write 维护的当前任务进度。
 */
import { useState, type JSX } from 'react';
import type { TodoSnapshot, TodoStatus, TodoSummary } from '../../protocol';

/** 任务面板属性。 */
export interface TodoPanelProps {
	/** 当前会话的完整任务快照。 */
	readonly snapshot: TodoSnapshot | null;
	/** 当前会话的状态汇总。 */
	readonly summary: TodoSummary | null;
}

/**
 * 根据任务状态返回紧凑的视觉标记。
 * @param status 当前任务状态。
 * @returns 状态标记。
 */
function statusMark(status: TodoStatus): string {
	switch (status) {
		case 'completed':
			return '✓';
		case 'in_progress':
			return '•';
		case 'cancelled':
			return '—';
		default:
			return '';
	}
}

/**
 * 展示或折叠当前会话的任务列表。
 * @param props 任务面板属性。
 * @returns 任务面板元素；无任务时不渲染。
 */
export function TodoPanel({ snapshot, summary }: TodoPanelProps): JSX.Element | null {
	const [expanded, setExpanded] = useState(true);
	if (!snapshot || !summary || snapshot.todos.length === 0) {
		return null;
	}

	return (
		<section className="todo-panel" aria-label="任务进度">
			<button
				type="button"
				className="todo-panel__header"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
			>
				<span className="todo-panel__chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
				<span className="todo-panel__title">任务进度</span>
				<span className="todo-panel__count">{summary.completed}/{summary.total}</span>
			</button>
			{expanded && (
				<ol className="todo-panel__list">
					{snapshot.todos.map((todo) => (
						<li className={`todo-panel__item todo-panel__item--${todo.status}`} key={todo.id}>
							<span className="todo-panel__status" aria-hidden="true">{statusMark(todo.status)}</span>
							<span>{todo.content}</span>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
