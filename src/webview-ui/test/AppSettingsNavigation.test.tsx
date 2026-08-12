/**
 * 根应用设置页导航测试。
 *
 * 职责：验证进入设置页后返回聊天不会丢失未发送输入，也不会产生设置相关的宿主消息。
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
	/** 打开和关闭设置页不会卸载聊天输入或发送配置请求。 */
	it('返回聊天后保留未发送的输入草稿', () => {
		render(<App />);
		act(() => bridge.listener?.({ command: 'sessionCreated', sessionId: 'session-1' }));

		fireEvent.change(screen.getByRole('textbox', { name: '消息输入' }), { target: { value: '保留这段草稿' } });
		fireEvent.click(screen.getByRole('button', { name: '设置' }));
		expect(screen.getByRole('heading', { name: '模型' })).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: '返回聊天' }));
		expect((screen.getByRole('textbox', { name: '消息输入' }) as HTMLTextAreaElement).value).toBe('保留这段草稿');
		expect(bridge.post.mock.calls.some(([message]) => (message as { command: string }).command === 'saveSettings')).toBe(false);
	});
});
