/**
 * Hooks 设置页组件测试。
 *
 * 覆盖 Hooks 导航顺序（MCP 下方、使用情况上方）、快照加载、配置保存、
 * RTK 检测/测试反馈、无效入站消息与窄窗口可访问性。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { SettingsPage } from '../components/settings/SettingsPage';

afterEach(() => {
	cleanup();
	bridge.listener = undefined;
	bridge.post.mockClear();
});

/** 通过订阅回调模拟宿主推送消息。 */
function emit(message: HostToWebviewMessage): void {
	act(() => bridge.listener?.(message));
}

/** 点击侧栏导航项。 */
function openSection(label: string): void {
	fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('Hooks 设置页', () => {
	it('挂载时请求 Hooks 快照', () => {
		render(<SettingsPage />);
		expect(bridge.post).toHaveBeenCalledWith({ command: 'requestHooksSnapshot' });
	});

	it('导航顺序：Hooks 位于 MCP 下方、使用情况上方', () => {
		const { container } = render(<SettingsPage />);
		const labels = Array.from(container.querySelectorAll('.settings-nav-item')).map((el) => el.textContent ?? '');
		expect(labels).toEqual(['模型', 'Skill', 'MCP', 'Hooks', '使用情况']);
	});

	it('点击 Hooks 分类显示运行状态、生命周期与 RTK 主卡片', () => {
		const { container } = render(<SettingsPage />);
		openSection('Hooks');
		expect(screen.getByRole('heading', { name: 'Hooks' })).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'Hooks 总开关' })).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'RTK 集成开关' })).toBeTruthy();
		expect(screen.getByRole('heading', { name: '生命周期' })).toBeTruthy();
		expect(screen.getByText('会话开始')).toBeTruthy();
		expect(screen.getByText('工具执行前')).toBeTruthy();
		expect(screen.getByText('工具执行后')).toBeTruthy();
		expect(screen.getByText('会话结束')).toBeTruthy();
		expect(screen.getByRole('region', { name: '已启用自动化' })).toBeTruthy();
		const advanced = container.querySelector('.hooks-advanced') as HTMLDetailsElement;
		expect(advanced.open).toBe(false);
		fireEvent.click(screen.getByText('高级配置'));
		expect(advanced.open).toBe(true);
		expect(screen.getByLabelText('RTK 可执行文件路径')).toBeTruthy();
		expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '测试改写' })).toBeTruthy();
	});

	it('快照加载：展示 Hooks 总开关与 RTK 可用状态/版本', async () => {
		render(<SettingsPage />);
		openSection('Hooks');
		emit({
			command: 'hooksSnapshot',
			config: { enabled: true, rtkEnabled: true, rtkExecutablePath: 'C:\\tools\\rtk.exe' },
			rtk: { available: true, version: 'rtk 1.2.3', lastDetectedAt: Date.now() },
		});
		await waitFor(() => expect(screen.getByRole('switch', { name: 'Hooks 总开关' }).getAttribute('aria-checked')).toBe('true'));
		expect(screen.getByRole('switch', { name: 'RTK 集成开关' }).getAttribute('aria-checked')).toBe('true');
		expect((screen.getByLabelText('RTK 可执行文件路径') as HTMLInputElement).value).toBe('C:\\tools\\rtk.exe');
		expect(screen.getByText('已就绪')).toBeTruthy();
		expect(screen.getByText('rtk 1.2.3')).toBeTruthy();
		expect(screen.getByText('1 个 Hook')).toBeTruthy();
	});

	it('快照加载：RTK 不可用时展示有界错误摘要', async () => {
		render(<SettingsPage />);
		openSection('Hooks');
		emit({
			command: 'hooksSnapshot',
			config: { enabled: true, rtkEnabled: true, rtkExecutablePath: 'C:\\missing\\rtk.exe' },
			rtk: { available: false, error: '无法启动 RTK 可执行文件: ENOENT', lastDetectedAt: Date.now() },
		});
		await waitFor(() => expect(screen.getByText(/无法启动 RTK 可执行文件/)).toBeTruthy());
	});

	it('保存：提交 saveHooksConfig（含 trim 后路径）', async () => {
		render(<SettingsPage />);
		openSection('Hooks');
		fireEvent.click(screen.getByText('高级配置'));
		const pathInput = screen.getByLabelText('RTK 可执行文件路径') as HTMLInputElement;
		fireEvent.change(pathInput, { target: { value: '  C:\\tools\\rtk.exe  ' } });
		fireEvent.click(screen.getByRole('button', { name: '保存' }));
		expect(bridge.post).toHaveBeenCalledWith({
			command: 'saveHooksConfig',
			enabled: true,
			rtkEnabled: false,
			rtkExecutablePath: 'C:\\tools\\rtk.exe',
		});
	});

	it('初始快照晚到时不会提前解除 Hooks 操作禁用状态', () => {
		render(<SettingsPage />);
		openSection('Hooks');
		fireEvent.click(screen.getByRole('button', { name: '保存' }));
		expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);
		emit({ command: 'hooksSnapshot', config: { enabled: true, rtkEnabled: false } });
		expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);
		emit({ command: 'hooksSnapshot', config: { enabled: true, rtkEnabled: false } });
		expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(false);
	});

	it('重新检测：提交 detectRtk，收到新快照后更新状态', async () => {
		render(<SettingsPage />);
		openSection('Hooks');
		fireEvent.click(screen.getByText('高级配置'));
		fireEvent.click(screen.getByRole('button', { name: '重新检测' }));
		expect(bridge.post).toHaveBeenCalledWith({ command: 'detectRtk' });
		emit({
			command: 'hooksSnapshot',
			config: { enabled: true, rtkEnabled: true, rtkExecutablePath: 'C:\\tools\\rtk.exe' },
			rtk: { available: true, version: 'rtk 9.9.9', lastDetectedAt: Date.now() },
		});
		await waitFor(() => expect(screen.getByText('rtk 9.9.9')).toBeTruthy());
	});

	it('测试改写：提交 testRtkRewrite，收到结果后展示改写命令', async () => {
		render(<SettingsPage />);
		openSection('Hooks');
		fireEvent.click(screen.getByText('高级配置'));
		fireEvent.click(screen.getByRole('button', { name: '测试改写' }));
		expect(bridge.post).toHaveBeenCalledWith({ command: 'testRtkRewrite' });
		emit({ command: 'hooksTestResult', sample: 'git status', rewritten: 'rtk git status' });
		await waitFor(() => expect(screen.getByText('改写预览')).toBeTruthy());
		expect(screen.getByText('rtk git status')).toBeTruthy();
	});

	it('测试改写失败：展示有界错误且不抛异常', async () => {
		render(<SettingsPage />);
		openSection('Hooks');
		emit({ command: 'hooksTestResult', sample: 'git status', error: 'RTK 不可用或无改写结果' });
		await waitFor(() => expect(screen.getByText(/RTK 不可用或无改写结果/)).toBeTruthy());
	});

	it('无效入站消息：settingsError 显示为错误反馈', async () => {
		render(<SettingsPage />);
		openSection('Hooks');
		emit({ command: 'settingsError', message: 'Hooks 配置字段非法' });
		await waitFor(() => expect(screen.getByText('Hooks 配置字段非法')).toBeTruthy());
	});

	it('窄窗口可访问性：导航与内容区容器存在，导航项可键盘可达', () => {
		const { container } = render(<SettingsPage />);
		openSection('Hooks');
		const nav = container.querySelector('.settings-nav nav');
		const content = container.querySelector('.settings-content');
		expect(nav).toBeTruthy();
		expect(content).toBeTruthy();
		// 窄窗口滚动行为由既有 @media 规则保证（导航横向滚动、内容区纵向滚动）；
		// 此处验证全部导航项为 button 元素且带 aria-label（键盘可达性与可访问性）。
		const navButtons = Array.from(nav?.querySelectorAll('button') ?? []);
		expect(navButtons.length).toBe(5);
		for (const btn of navButtons) {
			expect(btn.tagName).toBe('BUTTON');
			expect(btn.getAttribute('aria-label')).toBeTruthy();
		}
		expect(container.querySelector('.settings-content-inner')).toBeTruthy();
	});

	it('Hooks 快照推送不影响模型/Skill/MCP 草稿', async () => {
		render(<SettingsPage />);
		// 先加载模型快照
		emit({
			command: 'modelSettings',
			model: {
				provider: 'openai',
				model: 'gpt-4o-mini',
				baseURL: 'https://api.openai.com/v1',
				temperature: 0.7,
				maxTokens: 4096,
				apiKeyConfigured: true,
				models: [{ id: 'model-a', provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, runtime: 'ai-sdk', enabled: true, isDefault: true, apiKeyConfigured: true }],
			},
		});
		// 再推送 Hooks 快照
		emit({ command: 'hooksSnapshot', config: { enabled: false, rtkEnabled: false } });
		// 模型列表仍保留
		await waitFor(() => expect(screen.getByText('gpt-4o-mini')).toBeTruthy());
	});
});
