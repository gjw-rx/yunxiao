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
		<section className={`todo-panel${expanded ? '' : ' todo-panel--collapsed'}`} aria-label="任务进度">
			<button
				type="button"
				className="todo-panel__header"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
				aria-controls={expanded ? 'todo-panel-list' : undefined}
			>
				<span className="todo-panel__title">任务进度</span>
				<span className="todo-panel__summary">
					<span className="todo-panel__count">
						<strong>{summary.completed}</strong><span aria-hidden="true"> / </span>{summary.total}
					</span>
					<span className="todo-panel__toggle-icon" aria-hidden="true">
						<svg viewBox="0 0 12 12" fill="none">
							<path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
					</span>
				</span>
			</button>
			<div
				className="todo-panel__progress"
				role="progressbar"
				aria-label="任务完成进度"
				aria-valuemin={0}
				aria-valuemax={summary.total}
				aria-valuenow={summary.completed}
			>
				<span style={{ width: `${(summary.completed / summary.total) * 100}%` }} />
			</div>
			{expanded && (
				<ol id="todo-panel-list" className="todo-panel__list">
					{snapshot.todos.map((todo) => (
						<li className={`todo-panel__item todo-panel__item--${todo.status}`} key={todo.id}>
							<span className="todo-panel__status" aria-hidden="true">{statusMark(todo.status)}</span>
							<span className="todo-panel__content">{todo.content}</span>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
