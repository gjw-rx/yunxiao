/**
 * 会话任务面板 - 只读展示模型通过 todo_write 维护的当前任务进度。
 * review 阶段额外提供"执行计划 / 继续规划 / 退出规划"三种审阅操作。
 */
import { useState, type JSX } from 'react';
import type { PlanStage, TodoSnapshot, TodoStatus, TodoSummary } from '../../protocol';

/** 任务面板属性。 */
export interface TodoPanelProps {
	/** 当前会话的完整任务快照。 */
	readonly snapshot: TodoSnapshot | null;
	/** 当前会话的状态汇总。 */
	readonly summary: TodoSummary | null;
	/** 当前会话的 Plan 阶段；review 时显示审阅操作。 */
	readonly planStage?: PlanStage;
	/** 当前会话 ID（操作消息携带，防止过期会话操作）。 */
	readonly sessionId?: string | null;
	/** 执行计划（review → executing）。 */
	readonly onExecute: () => void;
	/** 继续规划（review → planning，保留草案）。 */
	readonly onContinue: () => void;
	/** 退出规划（回到 normal，按草案标记清理）。 */
	readonly onExit: () => void;
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
 * 展示或折叠当前会话的任务列表；review 阶段展示三种审阅操作。
 * @param props 任务面板属性。
 * @returns 任务面板元素；无任务时不渲染。
 */
export function TodoPanel({
	snapshot,
	summary,
	planStage,
	onExecute,
	onContinue,
	onExit,
}: TodoPanelProps): JSX.Element | null {
	const [expanded, setExpanded] = useState(true);
	// 审阅操作防抖：点击后短暂禁用，防止重复触发确认执行
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const act = (action: string, run: () => void): void => {
		if (pendingAction) {
			return;
		}
		setPendingAction(action);
		run();
		window.setTimeout(() => setPendingAction(null), 800);
	};
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
			{planStage === 'review' && (
				<div className="todo-panel__actions" role="group" aria-label="计划审阅操作">
					<button
						type="button"
						className="todo-panel__action todo-panel__action--primary"
						disabled={pendingAction !== null}
						onClick={() => act('execute', onExecute)}
					>
						执行计划
					</button>
					<button
						type="button"
						className="todo-panel__action"
						disabled={pendingAction !== null}
						onClick={() => act('continue', onContinue)}
					>
						继续规划
					</button>
					<button
						type="button"
						className="todo-panel__action todo-panel__action--ghost"
						disabled={pendingAction !== null}
						onClick={() => act('exit', onExit)}
					>
						退出规划
					</button>
				</div>
			)}
		</section>
	);
}
