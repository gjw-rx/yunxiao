/**
 * TodoPanel 只读展示与折叠交互测试。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TodoPanel } from '../components/chat/TodoPanel';

describe('TodoPanel', () => {
	it('展示完整快照并允许折叠，已完成任务不会被自动隐藏', () => {
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
		const header = screen.getByRole('button', { name: /任务进度/ });
		expect(header.getAttribute('aria-expanded')).toBe('true');
		fireEvent.click(header);
		expect(header.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByText('完成数据模型')).toBeNull();
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
