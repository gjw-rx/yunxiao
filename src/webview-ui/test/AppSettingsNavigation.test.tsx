/**
 * 根应用设置页导航测试。
 *
 * 职责：验证设置入口交由扩展宿主打开独立标签，不在聊天 Webview 内切换页面。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
	/** 捕获的宿主消息订阅回调。 */
	listener: undefined as undefined | ((message: { readonly command: string; readonly sessionId?: string }) => void),
	/** Webview 发往宿主的消息记录。 */
	post: vi.fn(),
}));

vi.mock('../bridge/vscode', () => ({
	post: bridge.post,
	subscribe: (listener: (message: { readonly command: string; readonly sessionId?: string }) => void) => {
		bridge.listener = listener;
		return (): void => undefined;
	},
}));

import { App } from '../App';

afterEach(() => {
	cleanup();
	bridge.listener = undefined;
	bridge.post.mockClear();
});

describe('App 设置页导航', () => {
	/** 点击设置只发送打开独立标签的请求，聊天页面保持原样。 */
	it('点击设置请求宿主打开独立编辑器标签', () => {
		render(<App />);
		act(() => bridge.listener?.({ command: 'sessionCreated', sessionId: 'session-1' }));

		fireEvent.change(screen.getByRole('textbox', { name: '消息输入' }), { target: { value: '保留这段草稿' } });
		fireEvent.click(screen.getByRole('button', { name: '设置' }));

		expect((screen.getByRole('textbox', { name: '消息输入' }) as HTMLTextAreaElement).value).toBe('保留这段草稿');
		expect(bridge.post).toHaveBeenCalledWith({ command: 'openSettings' });
		expect(screen.queryByRole('heading', { name: '模型' })).toBeNull();
	});
});
