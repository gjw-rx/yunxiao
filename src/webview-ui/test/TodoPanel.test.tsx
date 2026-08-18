/**
 * TodoPanel 只读展示与进度语义测试。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TodoPanel } from '../components/chat/TodoPanel';

/** 清理每个用例挂载的面板，避免审阅按钮残留到后续断言。 */
afterEach(() => {
	cleanup();
});

describe('TodoPanel', () => {
	it('展示任务流与完成进度，并可收缩为紧凑摘要', () => {
		render(
			<TodoPanel
				snapshot={{
					todos: [
						{ id: 'done', content: '完成数据模型', status: 'completed' },
						{ id: 'active', content: '实现任务面板', status: 'in_progress' },
					],
				}}
				summary={{ total: 2, pending: 0, in_progress: 1, completed: 1, cancelled: 0 }}
				onExecute={() => {}}
				onContinue={() => {}}
				onExit={() => {}}
			/>
		);

		expect(screen.getByText('完成数据模型')).toBeTruthy();
		expect(screen.getByText('实现任务面板')).toBeTruthy();
		const progress = screen.getByRole('progressbar', { name: '任务完成进度' });
		expect(progress.getAttribute('aria-valuenow')).toBe('1');
		expect(progress.getAttribute('aria-valuemax')).toBe('2');
		const toggle = screen.getByRole('button', { name: /任务进度/ });
		expect(toggle.getAttribute('aria-expanded')).toBe('true');

		fireEvent.click(toggle);

		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByText('完成数据模型')).toBeNull();
		expect(screen.getByRole('progressbar', { name: '任务完成进度' })).toBeTruthy();
	});

	it('空快照不渲染面板', () => {
		const { container } = render(
			<TodoPanel
				snapshot={{ todos: [] }}
				summary={{ total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 }}
				onExecute={() => {}}
				onContinue={() => {}}
				onExit={() => {}}
			/>
		);
		expect(container.innerHTML).toBe('');
	});

	it('review 阶段展示执行计划/继续规划/退出规划三个操作', () => {
		const onExecute = vi.fn();
		const onContinue = vi.fn();
		const onExit = vi.fn();
		render(
			<TodoPanel
				snapshot={{ todos: [{ id: 'p1', content: '计划', status: 'pending' }] }}
				summary={{ total: 1, pending: 1, in_progress: 0, completed: 0, cancelled: 0 }}
				planStage="review"
				sessionId="s1"
				onExecute={onExecute}
				onContinue={onContinue}
				onExit={onExit}
			/>
		);

		const execute = screen.getByRole('button', { name: '执行计划' });
		const continuePlan = screen.getByRole('button', { name: '继续规划' });
		const exit = screen.getByRole('button', { name: '退出规划' });
		fireEvent.click(execute);
		expect(onExecute).toHaveBeenCalledTimes(1);
		expect(continuePlan.getAttribute('disabled')).not.toBeNull();
		fireEvent.click(continuePlan);
		fireEvent.click(exit);
		expect(onContinue).not.toHaveBeenCalled();
		expect(onExit).not.toHaveBeenCalled();
	});

	it('非 review 阶段不展示审阅操作', () => {
		render(
			<TodoPanel
				snapshot={{ todos: [{ id: 'p1', content: '计划', status: 'pending' }] }}
				summary={{ total: 1, pending: 1, in_progress: 0, completed: 0, cancelled: 0 }}
				planStage="planning"
				onExecute={() => {}}
				onContinue={() => {}}
				onExit={() => {}}
			/>
		);
		expect(screen.queryByRole('button', { name: '执行计划' })).toBeNull();
	});
});
