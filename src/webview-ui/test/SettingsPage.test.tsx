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

	/** 窄宽度下模型列表应切换为紧凑布局，避免横向溢出后首列内容留空。 */
	it('窄宽度下模型列表使用紧凑布局', () => {
		const styles = readFileSync(resolve(process.cwd(), 'src/webview-ui/styles/chat.css'), 'utf8');
		const compactLayoutStart = styles.indexOf('@container (max-width: 620px)');
		const compactLayoutEnd = styles.indexOf('\n}\n.settings-empty-list', compactLayoutStart) + 2;
		const compactLayout = styles.slice(compactLayoutStart, compactLayoutEnd);

		expect(styles).toMatch(/\.settings-model-list-card\s*\{[^}]*container-type:\s*inline-size;/);
		expect(compactLayout).toMatch(/\.settings-model-table\s*\{[^}]*overflow:\s*hidden;/);
		expect(compactLayout).toMatch(/\.settings-model-table-head\s*\{\s*display:\s*none;/);
		expect(compactLayout).toMatch(/\.settings-model-table-row\s*\{[^}]*grid-template-areas:\s*"model actions"\s*"provider status";/);
		expect(compactLayout).toMatch(/\.settings-model-table-row > div:first-child\s*\{\s*grid-area:\s*model;/);
		expect(compactLayout).toMatch(/\.settings-model-table-row > span:nth-of-type\(1\)\s*\{\s*grid-area:\s*provider;/);
		expect(compactLayout).toMatch(/\.settings-model-table-row > span:nth-of-type\(2\)\s*\{\s*grid-area:\s*status;/);
		expect(compactLayout).toMatch(/\.settings-model-actions\s*\{[^}]*grid-area:\s*actions;/);
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

	/** Skill 页应提供 Agent 生态来源单选并提交切换请求。 */
	it('可切换配置来源为 Agent 并提交 setSyncSource', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
		emit({ command: 'skillsList', skills: [], source: 'claude', directories: ['.vscode/skills'], installTarget: '.claude/skills/<skill-name>/SKILL.md' });

		fireEvent.click(screen.getByRole('radio', { name: 'Agent' }));
		expect(bridge.post).toHaveBeenCalledWith({ command: 'setSyncSource', source: 'agent' });
	});

	/** 切换成功后的快照应反映 agent 来源，并展示来自全局目录的 Skill 来源路径。 */
	it('agent 来源同步成功后展示新加载 Skill 及来源路径', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
		emit({
			command: 'skillsList',
			skills: [{ name: 'plan', description: 'Agent 规划', sourcePath: '/home/user/.agents/skills/plan/SKILL.md' }],
			source: 'agent',
			directories: ['.vscode/skills'],
			installTarget: '.claude/skills/<skill-name>/SKILL.md',
		});

		expect(await screen.findByText('plan')).toBeTruthy();
		expect(screen.getByText('/home/user/.agents/skills/plan/SKILL.md')).toBeTruthy();
		expect((screen.getByRole('radio', { name: 'Agent' }) as HTMLInputElement).checked).toBe(true);
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

	/** 使用情况分类：首次进入请求宿主统计并展示受控视图。 */
	it('使用情况分类首次进入发起统计请求', () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
		expect(bridge.post).toHaveBeenCalledWith(expect.objectContaining({ command: 'requestUsageStats' }));
		expect(screen.getByLabelText('使用情况统计')).toBeTruthy();
	});
});

describe('SettingsPage Command 分类', () => {
	/** 挂载时请求 Command 快照。 */
	it('挂载时请求 Command 快照', () => {
		render(<SettingsPage />);
		expect(bridge.post).toHaveBeenCalledWith({ command: 'requestCommands' });
	});

	/** 导航项顺序：模型、Skill、命令、MCP、Hooks、使用情况。 */
	it('导航包含命令项且位于 Skill 与 MCP 之间', () => {
		const { container } = render(<SettingsPage />);
		const nav = container.querySelector('.settings-nav nav');
		const buttons = Array.from(nav?.querySelectorAll('button') ?? []);
		const labels = buttons.map((b) => b.textContent?.trim());
		expect(labels.indexOf('Skill')).toBeGreaterThan(-1);
		expect(labels.indexOf('命令')).toBeGreaterThan(labels.indexOf('Skill'));
		expect(labels.indexOf('MCP')).toBeGreaterThan(labels.indexOf('命令'));
	});

	/** 点击命令分类展示全局/项目标签与空状态。 */
	it('命令分类展示全局/项目标签与空状态', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '命令' }));
		emit({ command: 'commandsList', global: [], project: [], globalDirectory: '/u/.yunForce/command', projectDirectory: '/ws/.yunForce/command', projectAvailable: true });

		await waitFor(() => expect(screen.getByRole('heading', { name: '命令' })).toBeTruthy());
		expect(screen.getByRole('tab', { name: '全局' })).toBeTruthy();
		expect(screen.getByRole('tab', { name: '项目' })).toBeTruthy();
		expect(screen.getByText(/目录/)).toBeTruthy();
		expect(screen.getByText('暂无全局命令')).toBeTruthy();
	});

	/** 切换项目标签显示项目命令列表与覆盖标记。 */
	it('切换项目标签显示项目命令列表与覆盖标记', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '命令' }));
		emit({
			command: 'commandsList',
			global: [{ name: 'review', scope: 'global', overridden: true, sourcePath: '/u/.yunForce/command/review.md' }],
			project: [{ name: 'review', description: '项目版', scope: 'project', overridden: false, sourcePath: '/ws/.yunForce/command/review.md' }],
			globalDirectory: '/u/.yunForce/command',
			projectDirectory: '/ws/.yunForce/command',
			projectAvailable: true,
		});
		await waitFor(() => expect(screen.getByText('/review')).toBeTruthy());
		// 全局作用域展示被项目覆盖标记
		expect(screen.getByText('被项目覆盖')).toBeTruthy();
		fireEvent.click(screen.getByRole('tab', { name: '项目' }));
		expect(screen.getByText('项目版')).toBeTruthy();
	});

	/** 无工作区时项目作用域禁用并说明原因。 */
	it('无工作区时项目作用域禁用并说明原因', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '命令' }));
		emit({ command: 'commandsList', global: [], project: [], globalDirectory: '/u/.yunForce/command', projectAvailable: false });

		await waitFor(() => expect(screen.getByText('未打开工作区，无法管理项目 Command；全局作用域仍可用。')).toBeTruthy());
		expect(screen.getByRole('tab', { name: '项目' }).getAttribute('disabled')).not.toBeNull();
		// 项目 tab 未选中时创建按钮（全局作用域）仍可用
		const createButton = screen.getByRole('button', { name: '+ 创建命令' });
		expect(createButton.getAttribute('disabled')).toBeNull();
	});

	/** 创建 Command：提交 createCommand 并在成功后刷新列表与反馈。 */
	it('创建全局 Command 提交 createCommand，成功后刷新列表', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '命令' }));
		emit({ command: 'commandsList', global: [], project: [], globalDirectory: '/u/.yunForce/command', projectAvailable: true });
		await waitFor(() => expect(screen.getByRole('button', { name: '+ 创建命令' })).toBeTruthy());

		fireEvent.click(screen.getByRole('button', { name: '+ 创建命令' }));
		fireEvent.change(screen.getByLabelText('命令名'), { target: { value: 'review' } });
		fireEvent.change(screen.getByLabelText('命令正文'), { target: { value: '请审查当前改动' } });
		fireEvent.click(screen.getByRole('button', { name: '创建命令' }));

		expect(bridge.post).toHaveBeenCalledWith({
			command: 'createCommand',
			scope: 'global',
			input: { name: 'review', body: '请审查当前改动' },
		});
		// 宿主回推最新快照：列表刷新 + 成功反馈 + 表单关闭
		emit({
			command: 'commandsList',
			global: [{ name: 'review', scope: 'global', overridden: false, sourcePath: '/u/.yunForce/command/review.md' }],
			project: [],
			globalDirectory: '/u/.yunForce/command',
			projectAvailable: true,
		});
		await waitFor(() => expect(screen.getByText('命令已创建，列表已刷新')).toBeTruthy());
		expect(screen.queryByRole('button', { name: '创建命令' })).toBeNull();
	});

	/** 失败时回传 settingsError，表单草稿保留。 */
	it('创建失败保留表单草稿并展示错误', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '命令' }));
		emit({ command: 'commandsList', global: [], project: [], globalDirectory: '/u/.yunForce/command', projectAvailable: true });
		await waitFor(() => expect(screen.getByRole('button', { name: '+ 创建命令' })).toBeTruthy());

		fireEvent.click(screen.getByRole('button', { name: '+ 创建命令' }));
		fireEvent.change(screen.getByLabelText('命令名'), { target: { value: 'bad/name' } });
		fireEvent.change(screen.getByLabelText('命令正文'), { target: { value: '正文' } });
		fireEvent.click(screen.getByRole('button', { name: '创建命令' }));

		emit({ command: 'settingsError', message: '命令名不合法' });
		await waitFor(() => expect(screen.getByText('命令名不合法')).toBeTruthy());
		// 草稿保留：表单仍打开且名称未被清空
		expect((screen.getByLabelText('命令名') as HTMLInputElement).value).toBe('bad/name');
		expect((screen.getByLabelText('命令正文') as HTMLTextAreaElement).value).toBe('正文');
	});

	/** 删除 Command：二次确认后提交 deleteCommand 并刷新列表。 */
	it('删除 Command 需二次确认并提交 deleteCommand', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '命令' }));
		emit({
			command: 'commandsList',
			global: [{ name: 'review', scope: 'global', overridden: false, sourcePath: '/u/.yunForce/command/review.md' }],
			project: [],
			globalDirectory: '/u/.yunForce/command',
			projectAvailable: true,
		});
		await waitFor(() => expect(screen.getByRole('button', { name: '删除' })).toBeTruthy());

		fireEvent.click(screen.getByRole('button', { name: '删除' }));
		expect(screen.getByText('确认删除？')).toBeTruthy();
		expect(bridge.post).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'deleteCommand' }));
		fireEvent.click(screen.getByRole('button', { name: '确认' }));
		expect(bridge.post).toHaveBeenCalledWith({ command: 'deleteCommand', scope: 'global', name: 'review' });
	});
});
