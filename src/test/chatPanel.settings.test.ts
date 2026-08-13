/**
 * 设置面板宿主协议测试 - 覆盖模型配置读取/保存、Skill 列表、来源切换与安装的消息路由。
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
import type { SyncSource } from '../config/syncConfig';

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

/** 构造设置面板宿主测试环境（真实 ModelConfigStore + 内存存储 + 注入依赖）。 */
function setup() {
	const messages: Record<string, unknown>[] = [];
	const modelStore = new ModelConfigStore({
		globalState: createMemoryMemento(),
		secrets: createMemorySecrets(),
	} as unknown as vscode.ExtensionContext, fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-panel-store-')));
	const panel = createFakePanel(messages);
	const provider = new ChatViewProvider(
		{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
		{
			sessionManager: {} as unknown as LocalSessionManager,
			registry: {} as ToolRegistry,
			eventBus: { onAll: () => () => {} } as unknown as EventBus,
		}
	);
	const installedNames: string[] = [];
	const savedConfigs: unknown[] = [];
	let syncSource: SyncSource = 'claude';
	let skillDirectories = ['.vscode/skills'];
	provider.setSkillRegistry({
		list: () => [
			{ name: 'plan', description: '规划 Skill', sourcePath: '/ws/.claude/skills/plan/SKILL.md' },
		],
	} as never);
	provider.setSettingsDeps({
		modelStore,
		getSyncSource: () => syncSource,
		getSkillDirectories: () => skillDirectories,
		setSyncSource: async (source: SyncSource) => {
			syncSource = source;
			return source;
		},
		setSkillDirectories: async (directories: readonly string[]) => {
			skillDirectories = [...directories];
			return skillDirectories;
		},
		getModelName: () => 'gpt-4o-mini',
		uploadSkillArchive: async () => {
			installedNames.push('my-skill');
			return { ok: true, name: 'my-skill', filePath: '/ws/.claude/skills/my-skill/SKILL.md' };
		},
		onModelConfigSaved: (config) => {
			savedConfigs.push(config);
		},
	});
	const internals = provider as unknown as SettingsInternals;
	return {
		messages,
		panel,
		internals,
		installedNames,
		savedConfigs,
		currentSource: () => syncSource,
		currentDirectories: () => skillDirectories,
	};
}

/** 最近一条指定命令的消息。 */
function lastMessage(messages: Record<string, unknown>[], command: string): Record<string, unknown> | undefined {
	return [...messages].reverse().find((m) => m.command === command);
}

describe('ChatViewProvider 设置面板宿主协议', () => {
	it('requestModelSettings 返回非敏感字段与 apiKeyConfigured，不含密钥明文', async () => {
		const { messages, panel, internals } = setup();
		// 先保存一个带 Key 的配置，再请求视图
		await internals._handleSettingsMessage(panel, {
			command: 'saveModelSettings',
			model: { provider: 'openai', model: 'gpt-4o-mini', baseURL: 'https://x/v1', temperature: 0.7, maxTokens: 4096, apiKey: 'sk-plain' },
		});
		await internals._handleSettingsMessage(panel, { command: 'requestModelSettings' });

		const msg = lastMessage(messages, 'modelSettings');
		assert.ok(msg, '应返回 modelSettings');
		const model = msg?.model as Record<string, unknown>;
		assert.strictEqual(model.model, 'gpt-4o-mini');
		assert.strictEqual(model.apiKeyConfigured, true);
		assert.ok(!JSON.stringify(msg).includes('sk-plain'), '密钥明文不得回传');
	});

	it('saveModelSettings 成功：持久化、触发 onModelConfigSaved 并回推最新快照', async () => {
		const { messages, panel, internals, savedConfigs } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveModelSettings',
			model: { provider: 'openai', model: 'deepseek-chat', baseURL: 'https://ds/v1', temperature: 0.3, maxTokens: 2048, apiKey: 'sk-new' },
		});

		const msg = lastMessage(messages, 'modelSettingsSaved');
		assert.ok(msg, '应返回 modelSettingsSaved');
		const model = msg?.model as Record<string, unknown>;
		assert.strictEqual(model.model, 'deepseek-chat');
		assert.strictEqual(savedConfigs.length, 1);
		const saved = savedConfigs[0] as { model: string; apiKey: string };
		assert.strictEqual(saved.model, 'deepseek-chat');
		assert.strictEqual(saved.apiKey, 'sk-new');
	});

	it('saveModelSettings 校验失败：返回 settingsError 且不持久化', async () => {
		const { messages, panel, internals, savedConfigs } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveModelSettings',
			model: { provider: 'openai', model: '', baseURL: 'https://x/v1', temperature: 0.7, maxTokens: 4096 },
		});

		const msg = lastMessage(messages, 'settingsError');
		assert.ok(msg, '应返回 settingsError');
		assert.ok(String(msg?.message).includes('模型名称'));
		assert.strictEqual(savedConfigs.length, 0, '校验失败不得触发保存回调');
	});

	it('requestSkills 返回已加载 Skill 快照与配置来源', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, { command: 'requestSkills' });

		const msg = lastMessage(messages, 'skillsList');
		assert.ok(msg, '应返回 skillsList');
		const skills = msg?.skills as { name: string }[];
		assert.ok(Array.isArray(skills));
		assert.ok(skills.some((s) => s.name === 'plan'));
		assert.strictEqual(msg?.source, 'claude');
	});

	it('uploadSkillArchive 成功：调用 ZIP 安装并回推刷新后的 Skill 列表', async () => {
		const { messages, panel, internals, installedNames } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'uploadSkillArchive',
		});

		assert.deepStrictEqual(installedNames, ['my-skill']);
		const msg = lastMessage(messages, 'skillsList');
		assert.ok(msg, '安装成功应回推最新 skillsList');
	});

	it('uploadSkillArchive 失败：返回 settingsError 且不回推列表', async () => {
		const messages: Record<string, unknown>[] = [];
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
			modelStore: new ModelConfigStore({
				globalState: createMemoryMemento(),
				secrets: createMemorySecrets(),
			} as unknown as vscode.ExtensionContext, fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-panel-store-'))),
			getSyncSource: () => 'claude' as SyncSource,
			getSkillDirectories: () => ['.vscode/skills'],
			setSyncSource: async (source: SyncSource) => source,
			setSkillDirectories: async (directories: readonly string[]) => [...directories],
			getModelName: () => '',
			uploadSkillArchive: async () => ({ ok: false, reason: 'ZIP 包不符合 Skill 协议' }),
		});
		const internals = provider as unknown as SettingsInternals;

		await internals._handleSettingsMessage(panel, { command: 'uploadSkillArchive' });
		const msg = lastMessage(messages, 'settingsError');
		assert.ok(msg, '失败应返回 settingsError');
		assert.strictEqual(lastMessage(messages, 'skillsList'), undefined);
	});

	it('setSyncSource 保存来源并回推最新 Skill 快照', async () => {
		const { messages, panel, internals, currentSource } = setup();
		await internals._handleSettingsMessage(panel, { command: 'setSyncSource', source: 'trae' });

		assert.strictEqual(currentSource(), 'trae');
		const msg = lastMessage(messages, 'skillsList');
		assert.ok(msg, '来源切换后应回推最新 skillsList');
		assert.strictEqual(msg?.source, 'trae');
	});

	it('setSyncSource 切换为 agent 后保存并回推 agent 来源快照', async () => {
		const { messages, panel, internals, currentSource } = setup();
		await internals._handleSettingsMessage(panel, { command: 'setSyncSource', source: 'agent' });

		assert.strictEqual(currentSource(), 'agent');
		const msg = lastMessage(messages, 'skillsList');
		assert.ok(msg, '来源切换后应回推最新 skillsList');
		assert.strictEqual(msg?.source, 'agent');
	});

	it('setSkillDirectories 保存目录并回推重新加载后的 Skill 快照', async () => {
		const { messages, panel, internals, currentDirectories } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'setSkillDirectories',
			directories: ['.claude/skills', '.vscode/skills'],
		});

		assert.deepStrictEqual(currentDirectories(), ['.claude/skills', '.vscode/skills']);
		const msg = lastMessage(messages, 'skillsList');
		assert.ok(msg, '目录保存后应回推最新 Skill 快照');
		assert.deepStrictEqual(msg?.directories, ['.claude/skills', '.vscode/skills']);
	});
});
