/**
 * 设置页使用情况组件测试。
 *
 * 职责：覆盖首次进入才请求、粒度/周期切换、模型行与未知模型展示、
 * 空/partial/错误状态，以及模型/Skill/MCP/Hooks 草稿不被 usage 响应清空。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebviewMessage, TokenUsageStatsResult, UsageGranularity } from '../protocol';

const bridge = vi.hoisted(() => ({
	listener: undefined as undefined | ((message: HostToWebviewMessage) => void),
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

/** 通过订阅回调模拟宿主推送消息。 */
function emit(message: HostToWebviewMessage): void {
	act(() => bridge.listener?.(message));
}

/** 构造完整统计结果。 */
function statsResult(overrides: Partial<TokenUsageStatsResult> & { granularity?: UsageGranularity } = {}): TokenUsageStatsResult {
	return {
		granularity: overrides.granularity ?? 'day',
		start: '2026-08-15T00:00:00.000Z',
		end: '2026-08-16T00:00:00.000Z',
		total_tokens: 420,
		prompt_tokens: 360,
		completion_tokens: 60,
		partial: false,
		models: [
			{ provider_id: 'openai', model_id: 'gpt-4o', model_label: 'gpt-4o', total_tokens: 240, prompt_tokens: 200, completion_tokens: 40, reasoning_tokens: 0, cache_read_tokens: 80, cache_write_tokens: 0, no_cache_tokens: 120 },
			{ provider_id: 'openai', model_id: 'gpt-4o-mini', model_label: 'gpt-4o-mini', total_tokens: 180, prompt_tokens: 160, completion_tokens: 20, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, no_cache_tokens: 0 },
		],
		...overrides,
	};
}

/** 切换到"使用情况"分类并推送给定统计结果。 */
function openUsageAndEmit(payload: TokenUsageStatsResult): void {
	render(<SettingsPage />);
	fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
	emit({ command: 'usageStats', payload });
}

afterEach(() => {
	cleanup();
	bridge.listener = undefined;
	bridge.post.mockClear();
});

describe('SettingsPage 使用情况', () => {
	it('首次进入"使用情况"才请求当前自然日，不在挂载时预取', () => {
		render(<SettingsPage />);
		// 挂载时不应请求 usage
		expect(bridge.post).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'requestUsageStats' }));
		fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
		// 进入分类后请求一次当前自然日
		expect(bridge.post).toHaveBeenCalledWith({
			command: 'requestUsageStats',
			granularity: 'day',
			reference: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		});
		bridge.post.mockClear();
		// 离开再进入不重复请求（已有结果）
		fireEvent.click(screen.getByRole('button', { name: '模型' }));
		emit({ command: 'usageStats', payload: statsResult() });
		fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
		expect(bridge.post).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'requestUsageStats' }));
	});

	it('验证首次进入的同一引用日期只请求一次', () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
		const requests = bridge.post.mock.calls.filter((c) => (c[0] as { command?: string }).command === 'requestUsageStats');
		expect(requests).toHaveLength(1);
	});

	it('切换粒度触发放大请求并展示新结果', async () => {
		openUsageAndEmit(statsResult());
		await screen.findByText('gpt-4o');
		fireEvent.click(screen.getByRole('radio', { name: '周' }));
		expect(bridge.post).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'requestUsageStats', granularity: 'week' }));
		// 推送周结果
		emit({ command: 'usageStats', payload: statsResult({ granularity: 'week', total_tokens: 900, models: [{ provider_id: 'openai', model_id: 'gpt-4o', model_label: 'gpt-4o', total_tokens: 900, prompt_tokens: 700, completion_tokens: 200, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, no_cache_tokens: 0 }] }) });
		await screen.findAllByText('900');
		expect(screen.queryByText('gpt-4o-mini')).toBeNull();
	});

	it('前后周期导航触发对应粒度的请求', async () => {
		openUsageAndEmit(statsResult());
		fireEvent.click(screen.getByRole('button', { name: '下一周期' }));
		expect(bridge.post).toHaveBeenCalledWith(expect.objectContaining({ command: 'requestUsageStats', granularity: 'day' }));
		fireEvent.click(screen.getByRole('button', { name: '上一周期' }));
		expect(bridge.post).toHaveBeenCalledWith(expect.objectContaining({ command: 'requestUsageStats', granularity: 'day' }));
	});

	it('按 total 降序展示模型行，未知模型显示中文标签', async () => {
		openUsageAndEmit(
			statsResult({
				models: [
					{ provider_id: 'openai', model_id: 'unknown', model_label: '未知模型', total_tokens: 60, prompt_tokens: 50, completion_tokens: 10, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, no_cache_tokens: 0 },
					{ provider_id: 'openai', model_id: 'gpt-4o-mini', model_label: 'gpt-4o-mini', total_tokens: 180, prompt_tokens: 160, completion_tokens: 20, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, no_cache_tokens: 0 },
				],
			}),
		);
		await screen.findByText('gpt-4o-mini');
		expect(screen.getByText('未知模型')).toBeTruthy();
		// 模型行按 total 降序（第一行 gpt-4o-mini 180 > 未知模型 60）
		const rows = screen.getAllByRole('row');
		const firstRow = rows[1];
		expect(firstRow.textContent).toContain('gpt-4o-mini');
		expect(firstRow.textContent).not.toContain('未知模型');
	});

	it('空数据展示空状态且不报错', async () => {
		openUsageAndEmit(statsResult({ total_tokens: 0, models: [] }));
		await screen.findByText('该时段暂无已记录 token 用量');
		expect(screen.queryByRole('table')).toBeNull();
	});

	it('partial 响应展示数据并提示可能不完整', async () => {
		openUsageAndEmit(statsResult({ partial: true }));
		await screen.findByText('gpt-4o');
		expect(screen.getByText(/部分会话归档无法读取/)).toBeTruthy();
	});

	it('错误状态展示有界错误并可重试', async () => {
		render(<SettingsPage />);
		fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
		emit({ command: 'usageStatsError', message: '用量统计失败，请重试' });
		await screen.findByText('用量统计失败，请重试');
		fireEvent.click(screen.getByRole('button', { name: '重试' }));
		expect(bridge.post).toHaveBeenCalledWith(expect.objectContaining({ command: 'requestUsageStats' }));
	});

	it('usage 响应不清空模型、Skill、MCP、Hooks 草稿', async () => {
		render(<SettingsPage />);
		// 先推送各分类数据
		const modelView = { provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, apiKeyConfigured: true, models: [{ id: 'model-a', provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, runtime: 'ai-sdk' as const, enabled: true, isDefault: true, apiKeyConfigured: true }] };
		emit({ command: 'modelSettings', model: modelView });
		emit({ command: 'skillsList', skills: [{ name: 'plan', description: '规划' }], source: 'claude', directories: [] });
		emit({ command: 'mcpSettings', servers: [{
			id: 'demo',
			configuredTransport: 'stdio',
			actualTransport: 'stdio',
			enabled: true,
			status: 'ready',
			toolCount: 0,
			tools: [],
			config: { type: 'stdio', command: 'demo', args: [], envKeys: [], enabled: true, connectTimeoutMs: 30000, callTimeoutMs: 60000 },
		}] });
		emit({ command: 'hooksSnapshot', config: { enabled: true, rtkEnabled: false } });

		fireEvent.click(screen.getByRole('button', { name: '使用情况' }));
		emit({ command: 'usageStats', payload: statsResult() });
		await screen.findByText('gpt-4o');

		// 其他分类数据仍完整（未被 usage 响应清空）
		fireEvent.click(screen.getByRole('button', { name: '模型' }));
		expect(screen.queryByText('gpt-4o-mini')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
		expect(screen.queryByText('plan')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
		expect(screen.queryAllByText('demo').length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole('button', { name: 'Hooks' }));
		expect(screen.queryByText(/运行中/)).toBeTruthy();
	});
});