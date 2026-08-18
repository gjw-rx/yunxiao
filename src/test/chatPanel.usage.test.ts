/**
 * 设置页使用情况宿主消息处理测试 - 覆盖合法日/周/月请求、无数据响应、
 * partial 响应与整体失败不影响其他设置消息。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../chatPanel';
import type { LocalSessionManager } from '../core/localSessionManager';
import type { ToolRegistry } from '../core/toolRegistry';
import type { EventBus } from '../core/eventBus';
import { ModelConfigStore } from '../config/modelConfigStore';
import type { UsageGranularity, TokenUsageStatsResult } from '../webview-ui/protocol';

interface SettingsInternals {
	_handleSettingsMessage(
		panel: vscode.WebviewPanel,
		msg: { command: string; [key: string]: unknown }
	): Promise<void>;
}

/** 内存版 globalState（vscode.Memento 兼容形状）。 */
function createMemoryMemento() {
	const data = new Map<string, unknown>();
	return {
		get: <T>(key: string, def?: T): T | undefined =>
			data.has(key) ? (data.get(key) as T) : def,
		update: async (key: string, value: unknown): Promise<void> => {
			if (value === undefined) {
				data.delete(key);
			} else {
				data.set(key, value);
			}
		},
		keys: (): readonly string[] => [...data.keys()],
	};
}

/** 内存版 secrets（vscode.SecretStorage 兼容形状）。 */
function createMemorySecrets() {
	const data = new Map<string, string>();
	return {
		get: async (key: string): Promise<string | undefined> => data.get(key),
		store: async (key: string, value: string): Promise<void> => {
			data.set(key, value);
		},
		delete: async (key: string): Promise<void> => {
			data.delete(key);
		},
		onDidChange: (): vscode.Disposable => ({ dispose: () => undefined }),
	};
}

/** 记录 postMessage 的假 WebviewPanel。 */
function createFakePanel(messages: Record<string, unknown>[]): vscode.WebviewPanel {
	return {
		webview: { postMessage: (m: Record<string, unknown>) => messages.push(m) },
	} as unknown as vscode.WebviewPanel;
}

/** 构造带用量统计依赖的设置宿主。 */
function setup(requestImpl: (granularity: UsageGranularity, reference: string) => Promise<TokenUsageStatsResult>) {
	const messages: Record<string, unknown>[] = [];
	const modelStore = new ModelConfigStore({
		globalState: createMemoryMemento(),
		secrets: createMemorySecrets(),
	} as unknown as vscode.ExtensionContext, fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-usage-test-')));
	const panel = createFakePanel(messages);
	const provider = new ChatViewProvider(
		{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
		{
			sessionManager: {} as unknown as LocalSessionManager,
			registry: {} as ToolRegistry,
			eventBus: { onAll: () => () => {} } as unknown as EventBus,
		}
	);
	provider.setSettingsDeps({
		modelStore,
		getSyncSource: () => 'claude',
		getSkillDirectories: () => [],
		setSyncSource: async (source) => source,
		setSkillDirectories: async (directories) => [...directories],
		getModelName: () => 'gpt-4o-mini',
		uploadSkillArchive: async () => ({ ok: true, name: 'x', filePath: '/x/SKILL.md' }),
		requestUsageStats: requestImpl,
	});
	return { messages, panel, internals: provider as unknown as SettingsInternals };
}

/** 最近一条指定命令的消息。 */
function lastByCommand(messages: Record<string, unknown>[], command: string): Record<string, unknown> | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].command === command) {
			return messages[i];
		}
	}
	return undefined;
}

describe('设置页使用情况宿主消息处理', () => {
	const emptyResult = (granularity: UsageGranularity): TokenUsageStatsResult => ({
		granularity,
		start: '2026-08-15T00:00:00.000Z',
		end: '2026-08-16T00:00:00.000Z',
		total_tokens: 0,
		prompt_tokens: 0,
		completion_tokens: 0,
		partial: false,
		models: [],
	});

	it('合法日请求回传标准化区间与统计快照', async () => {
		const requested: { g: UsageGranularity; r: string }[] = [];
		const { messages, internals } = setup(async (g, r) => {
			requested.push({ g, r });
			return {
				...emptyResult('day'),
				total_tokens: 120,
				prompt_tokens: 100,
				completion_tokens: 20,
				models: [
					{ provider_id: 'openai', model_id: 'gpt-4o-mini', model_label: 'gpt-4o-mini', total_tokens: 120, prompt_tokens: 100, completion_tokens: 20, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, no_cache_tokens: 0 },
				],
			};
		});
		await internals._handleSettingsMessage(createFakePanel(messages), { command: 'requestUsageStats', granularity: 'day', reference: '2026-08-15' });

		assert.deepStrictEqual(requested, [{ g: 'day', r: '2026-08-15' }]);
		const resp = lastByCommand(messages, 'usageStats');
		assert.ok(resp, '应回传 usageStats');
		const payload = resp!.payload as TokenUsageStatsResult;
		assert.strictEqual(payload.granularity, 'day');
		assert.strictEqual(payload.start, '2026-08-15T00:00:00.000Z');
		assert.strictEqual(payload.total_tokens, 120);
		assert.strictEqual(payload.models.length, 1);
		assert.strictEqual(payload.partial, false);
	});

	it('合法周/月请求传回对应粒度', async () => {
		const requested: UsageGranularity[] = [];
		const { messages, internals } = setup(async (g) => {
			requested.push(g);
			return emptyResult(g);
		});
		await internals._handleSettingsMessage(createFakePanel(messages), { command: 'requestUsageStats', granularity: 'week', reference: '2026-08-12' });
		await internals._handleSettingsMessage(createFakePanel(messages), { command: 'requestUsageStats', granularity: 'month', reference: '2026-08-01' });
		assert.deepStrictEqual(requested, ['week', 'month']);
	});

	it('无数据响应：总量为 0 且模型列表为空', async () => {
		const { messages, internals } = setup(async () => emptyResult('day'));
		await internals._handleSettingsMessage(createFakePanel(messages), { command: 'requestUsageStats', granularity: 'day', reference: '2026-08-15' });
		const resp = lastByCommand(messages, 'usageStats')!;
		const payload = resp.payload as TokenUsageStatsResult;
		assert.strictEqual(payload.total_tokens, 0);
		assert.deepStrictEqual(payload.models, []);
	});

	it('partial 响应：统计服务返回 partial 时原样回传', async () => {
		const { messages, internals } = setup(async (g) => ({ ...emptyResult(g), partial: true, total_tokens: 50 }));
		await internals._handleSettingsMessage(createFakePanel(messages), { command: 'requestUsageStats', granularity: 'day', reference: '2026-08-15' });
		const resp = lastByCommand(messages, 'usageStats')!;
		const payload = resp.payload as TokenUsageStatsResult;
		assert.strictEqual(payload.partial, true);
		assert.strictEqual(payload.total_tokens, 50);
	});

	it('整体失败回传有界错误且不影响其他设置消息', async () => {
		const { messages, internals } = setup(async () => {
			throw new Error('归档读取失败');
		});
		// 先发送一个常规设置消息（requestSkills），确认不受 usage 失败影响
		await internals._handleSettingsMessage(createFakePanel(messages), { command: 'requestSkills' });
		await internals._handleSettingsMessage(createFakePanel(messages), { command: 'requestUsageStats', granularity: 'day', reference: '2026-08-15' });

		const err = lastByCommand(messages, 'usageStatsError');
		assert.ok(err, '应回传 usageStatsError');
		assert.strictEqual(err!.message, '用量统计失败，请重试');
		// 其他设置消息（skillsList）不受影响且仍可处理
		assert.ok(lastByCommand(messages, 'skillsList'), 'requestSkills 应正常返回');
	});

	it('非法粒度回退为 day，非法参考日期回退当前日期', async () => {
		const requested: { g: UsageGranularity; r: string }[] = [];
		const { messages, internals } = setup(async (g, r) => {
			requested.push({ g, r });
			return emptyResult(g);
		});
		await internals._handleSettingsMessage(createFakePanel(messages), { command: 'requestUsageStats', granularity: 'bogus', reference: 'not-a-date' });
		assert.strictEqual(requested[0].g, 'day');
		assert.match(requested[0].r, /^\d{4}-\d{2}-\d{2}$/, '非法参考日期应回退为当前日期 YYYY-MM-DD');
	});
});