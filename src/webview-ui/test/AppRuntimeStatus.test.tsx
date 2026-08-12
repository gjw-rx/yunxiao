/**
 * 根应用运行时启动状态测试。
 *
 * 职责：确保 Skill 初始化期间只显示加载状态，且仅在宿主报告就绪后请求初始聊天数据。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebviewMessage } from '../protocol';

const bridge = vi.hoisted(() => ({
	/** 捕获的宿主消息订阅回调。 */
	listener: undefined as undefined | ((message: HostToWebviewMessage) => void),
	/** Webview 发往宿主的消息记录。 */
	post: vi.fn(),
}));

vi.mock('../bridge/vscode', () => ({
	post: bridge.post,
	subscribe: (listener: (message: HostToWebviewMessage) => void) => {
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

describe('App 运行时启动状态', () => {
	/** 初始化期间不显示聊天控件，也不请求创建会话。 */
	it('初始化期间显示加载页，收到 ready 后只请求一次初始数据', () => {
		render(<App />);

		expect(screen.getByText('正在加载 Skill…')).toBeTruthy();
		expect(bridge.post).toHaveBeenCalledWith({ command: 'webviewReady' });
		expect(bridge.post).not.toHaveBeenCalledWith({ command: 'createSession' });

		act(() => bridge.listener?.({ command: 'runtimeState', status: 'ready' }));
		act(() => bridge.listener?.({ command: 'runtimeState', status: 'ready' }));

		expect(bridge.post).toHaveBeenCalledTimes(3);
		expect(bridge.post).toHaveBeenCalledWith({ command: 'requestSlashCommands' });
		expect(bridge.post).toHaveBeenCalledWith({ command: 'createSession' });
	});

	/** 初始化失败时保持不可交互的失败提示。 */
	it('初始化失败时不创建会话并展示失败原因', () => {
		render(<App />);
		act(() => bridge.listener?.({ command: 'runtimeState', status: 'failed', message: 'Skill 加载失败' }));

		expect(screen.getAllByText('Skill 加载失败')).toHaveLength(2);
		expect(bridge.post).not.toHaveBeenCalledWith({ command: 'createSession' });
	});
});
