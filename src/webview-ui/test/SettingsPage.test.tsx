/**
 * 设置页组件测试。
 *
 * 职责：通过 mock 宿主协议验证加载、保存成功、校验失败、Skill 空状态与安装反馈。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('SettingsPage', () => {
	/** 挂载即请求模型配置与 Skill 快照。 */
	it('挂载时请求模型配置与 Skill 列表', () => {
		render(<SettingsPage />);
		expect(bridge.post).toHaveBeenCalledWith({ command: 'requestModelSettings' });
		expect(bridge.post).toHaveBeenCalledWith({ command: 'requestSkills' });
	});

	/** 默认不展开连接设置，避免直接暴露当前模型的编辑表单。 */
	it('默认不展开模型连接设置', async () => {
		render(<SettingsPage />);
		emit({
			command: 'modelSettings',
			model: {
				provider: 'openai',
				model: 'gpt-4o-mini',
				baseURL: 'https://api.openai.com/v1',
				temperature: 0.7,
				maxTokens: 4096,
				apiKeyConfigured: true,
			},
		});

		expect(screen.queryByRole('heading', { name: '连接设置' })).toBeNull();
	});

	/** 编辑模型时回填其非敏感字段与 API Key 已配置状态（不回显明文）。 */
	it('编辑模型时同步当前模型数据', async () => {
		const { container } = render(<SettingsPage />);
		emit({
			command: 'modelSettings',
			model: {
				provider: 'openai',
				model: 'gpt-4o-mini',
				baseURL: 'https://api.openai.com/v1',
				temperature: 0.7,
				maxTokens: 4096,
				runtime: 'ai-sdk',
				apiKeyConfigured: true,
				models: [{ id: 'model-a', provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, runtime: 'ai-sdk', enabled: true, isDefault: true, apiKeyConfigured: true }],
			},
		});

		await waitFor(() => expect(screen.getByText('gpt-4o-mini')).toBeTruthy());
		fireEvent.click(screen.getByRole('button', { name: '编辑' }));
		await waitFor(() => expect(screen.getByRole('heading', { name: '连接设置' })).toBeTruthy());
		expect((screen.getByLabelText('默认模型') as HTMLInputElement).value).toBe('gpt-4o-mini');
		expect((screen.getByLabelText('API 地址') as HTMLInputElement).value).toBe('https://api.openai.com/v1');
		expect(screen.getByText(/API Key（已配置/)).toBeTruthy();
		// 页面不得出现密钥明文
		expect(screen.queryByText(/sk-/)).toBeNull();
		expect(screen.getByRole('heading', { name: '生成参数' })).toBeTruthy();
		expect(container.querySelectorAll('.settings-form-grid')).toHaveLength(2);
		expect(screen.getByRole('button', { name: '保存模型配置' }).closest('.settings-card-footer')).toBeTruthy();
	});

	/** 多模型快照应展示列表，并能提交默认模型与启用状态操作。 */
	it('展示多模型列表并发送默认模型和启停操作', async () => {
		render(<SettingsPage />);
		emit({
			command: 'modelSettings',
			model: {
				defaultModelId: 'model-a', provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, apiKeyConfigured: true,
				models: [
					{ id: 'model-a', provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, runtime: 'ai-sdk', enabled: true, isDefault: true, apiKeyConfigured: true },
					{ id: 'model-b', provider: 'openai', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1', temperature: 0.3, maxTokens: 8192, runtime: 'ai-sdk', enabled: true, isDefault: false, apiKeyConfigured: true },
				],
			},
		});

		await waitFor(() => expect(screen.getByRole('table', { name: '模型列表' })).toBeTruthy());
		const desktopStyles = readFileSync(resolve(process.cwd(), 'src/webview-ui/styles/chat.css'), 'utf8').split('@media', 1)[0];
		expect(desktopStyles).toMatch(/\.settings-model-table\s*\{[^}]*overflow-x:\s*auto;/);
		expect(screen.getByText('deepseek-chat')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: '设为默认' }));
		expect(bridge.post).toHaveBeenCalledWith({ command: 'setDefaultModel', modelId: 'model-b' });
	});

	/** 点击添加模型必须清空字段且创建新条目，而不是覆盖当前默认模型。 */
	it('添加模型时清空全部参数且不携带已有模型 ID', async () => {
		render(<SettingsPage />);
		emit({
			command: 'modelSettings',
			model: {
				defaultModelId: 'model-a', provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, apiKeyConfigured: false,
				models: [{ id: 'model-a', provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, runtime: 'ai-sdk', enabled: true, isDefault: true, apiKeyConfigured: false }],
			},
		});
		fireEvent.click(screen.getByRole('button', { name: '+ 添加模型' }));
		expect((screen.getByLabelText('模型服务') as HTMLSelectElement).value).toBe('');
		expect((screen.getByLabelText('默认模型') as HTMLInputElement).value).toBe('');
		expect((screen.getByLabelText('API 地址') as HTMLInputElement).value).toBe('');
		expect((screen.getByLabelText('温度') as HTMLInputElement).value).toBe('');
		expect((screen.getByLabelText('最大输出 token') as HTMLInputElement).value).toBe('');
		expect((screen.getByLabelText('模型运行时') as HTMLSelectElement).value).toBe('');
		fireEvent.change(screen.getByLabelText('模型服务'), { target: { value: 'openai' } });
		fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'new-model' } });
		fireEvent.click(screen.getByRole('button', { name: '保存模型配置' }));
		expect(bridge.post).toHaveBeenCalledWith({ command: 'saveModelSettings', model: expect.objectContaining({ id: undefined, model: 'new-model' }) });
	});

	/** 保存成功：发送 saveModelSettings，收到确认后展示成功反馈。 */
	it('保存模型配置成功并显示反馈', async () => {
		render(<SettingsPage />);
		emit({
			command: 'modelSettings',
			model: { provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, apiKeyConfigured: false },
		});
		fireEvent.click(screen.getByRole('button', { name: '+ 添加模型' }));
		fireEvent.change(screen.getByLabelText('模型服务'), { target: { value: 'openai' } });

		fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'deepseek-chat' } });
		fireEvent.click(screen.getByRole('button', { name: '保存模型配置' }));

		expect(bridge.post).toHaveBeenCalledWith({
			command: 'saveModelSettings',
			model: expect.objectContaining({ model: 'deepseek-chat' }),
		});

		emit({
			command: 'modelSettingsSaved',
			model: { provider: 'openai', model: 'deepseek-chat', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, apiKeyConfigured: false },
		});
		expect(await screen.findByText(/模型配置已保存/)).toBeTruthy();
	});

	/** 模型页应提交包括运行时在内的全部模型配置字段。 */
	it('保存模型配置时包含模型运行时', async () => {
		render(<SettingsPage />);
		emit({
			command: 'modelSettings',
			model: {
				provider: 'openai',
				model: 'gpt-4o-mini',
				baseURL: 'https://api.openai.com/v1',
				temperature: 0.7,
				maxTokens: 4096,
				runtime: 'ai-sdk',
				apiKeyConfigured: false,
			},
		});

		fireEvent.click(screen.getByRole('button', { name: '+ 添加模型' }));
		fireEvent.change(screen.getByLabelText('模型运行时'), { target: { value: 'legacy' } });
		fireEvent.click(screen.getByRole('button', { name: '保存模型配置' }));

		expect(bridge.post).toHaveBeenCalledWith({
			command: 'saveModelSettings',
			model: expect.objectContaining({ runtime: 'legacy' }),
		});
	});

	/** 校验失败：宿主返回 settingsError 时展示可读错误。 */
	it('保存校验失败展示错误反馈', async () => {
		render(<SettingsPage />);
		emit({
			command: 'modelSettings',
			model: { provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, apiKeyConfigured: false },
		});
		fireEvent.click(screen.getByRole('button', { name: '+ 添加模型' }));
		expect(screen.getByRole('button', { name: '保存模型配置' })).toBeTruthy();

		emit({ command: 'settingsError', message: '温度参数需在 0-2 之间' });
		expect(await screen.findByText('温度参数需在 0-2 之间')).toBeTruthy();
	});

	/** Skill 分类：空列表展示明确空状态。 */
	it('Skill 空状态显示提示', () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
		emit({ command: 'skillsList', skills: [], source: 'claude', directories: ['.vscode/skills'], installTarget: '.claude/skills/<skill-name>/SKILL.md' });

		expect(screen.getByText('暂无已加载 Skill')).toBeTruthy();
	});

	/** Skill 页应允许维护加载目录，并将变更提交给宿主刷新。 */
	it('保存 Skill 加载目录并请求重新加载', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
		emit({
			command: 'skillsList',
			skills: [],
			source: 'claude',
			directories: ['.claude/skills'],
			installTarget: '.claude/skills/<skill-name>/SKILL.md',
		});

		await waitFor(() => expect((screen.getByLabelText('Skill 加载目录') as HTMLTextAreaElement).value).toBe('.claude/skills'));
		fireEvent.change(screen.getByLabelText('Skill 加载目录'), { target: { value: '.claude/skills\n.vscode/skills' } });
		fireEvent.click(screen.getByRole('button', { name: '保存并重新加载 Skill' }));

		expect(bridge.post).toHaveBeenCalledWith({
			command: 'setSkillDirectories',
			directories: ['.claude/skills', '.vscode/skills'],
		});
	});

	/** ZIP 上传：请求宿主选择文件，收到新快照后展示成功反馈。 */
	it('上传 Skill ZIP 并显示反馈', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
		emit({ command: 'skillsList', skills: [], source: 'claude', directories: ['.vscode/skills'], installTarget: '.claude/skills/<skill-name>/SKILL.md' });
		await waitFor(() => expect(screen.getByRole('button', { name: /选择 Skill ZIP 文件/ })).toBeTruthy());
		expect(screen.getByText(/Frontmatter：/)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /选择 Skill ZIP 文件/ }));

		expect(bridge.post).toHaveBeenCalledWith({ command: 'uploadSkillArchive' });

		emit({
			command: 'skillsList',
			skills: [{ name: 'my-skill', description: 'x', sourcePath: '/ws/.claude/skills/my-skill/SKILL.md' }],
			source: 'claude',
			directories: ['.vscode/skills'],
			installTarget: '.claude/skills/<skill-name>/SKILL.md',
		});
		expect(await screen.findByText(/Skill ZIP 已校验并安装/)).toBeTruthy();
		expect(screen.getByText('my-skill')).toBeTruthy();
	});

	/** Skill 页面应先提供上传入口，再展示已加载列表。 */
	it('Skill 上传区位于已加载列表之前', async () => {
		const { container } = render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
		emit({ command: 'skillsList', skills: [], source: 'claude', directories: ['.vscode/skills'], installTarget: '.claude/skills/<skill-name>/SKILL.md' });

		await waitFor(() => expect(container.querySelector('[aria-label="上传 Skill ZIP"]')).toBeTruthy());
		const uploadSection = container.querySelector('[aria-label="上传 Skill ZIP"]');
		const loadedSection = container.querySelector('[aria-label="已加载 Skill"]');

		if (!uploadSection || !loadedSection) {
			throw new Error('Skill 上传区或已加载列表未渲染');
		}
		expect(uploadSection.compareDocumentPosition(loadedSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	/** 使用情况分类保持静态占位。 */
	it('使用情况分类为静态占位', () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
		expect(screen.getByText('使用情况数据将在后续版本接入')).toBeTruthy();
	});
});
