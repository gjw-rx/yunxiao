/**
 * TodoPanel 只读展示与进度语义测试。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TodoPanel } from '../components/chat/TodoPanel';

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
			/>
		);
		expect(container.innerHTML).toBe('');
	});
});
