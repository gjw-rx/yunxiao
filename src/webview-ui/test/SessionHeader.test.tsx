/**
 * 会话头部组件测试。
 *
 * 职责：锁定新建会话、设置与历史会话入口的显示顺序，避免设置页入口破坏历史功能。
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../bridge/vscode', () => ({ post: vi.fn() }));

import { SessionHeader } from '../components/session/SessionHeader';

describe('SessionHeader', () => {
	/** 设置按钮位于新建会话与历史会话之间。 */
	it('按新建会话、设置、历史会话的顺序显示会话操作', () => {
		const { container } = render(
			<SessionHeader currentSessionId="session-1" sessionTitle="测试会话" sessions={[]} onOpenSettings={vi.fn()} />,
		);
		const buttons = Array.from(container.querySelectorAll('.session-actions button'));

		expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['新建会话', '设置', '历史会话']);
	});
});
