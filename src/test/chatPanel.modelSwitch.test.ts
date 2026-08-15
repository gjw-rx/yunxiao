/**
 * /model 切换模型宿主处理测试 - 覆盖 `switchModel` 消息的模型选择、切换回调与异常分支。
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

interface PanelInternals {
	_chatWebview?: vscode.Webview;
	_handleMessage(msg: { command: string; [key: string]: unknown }): Promise<void>;
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

/** 构造 /model 切换测试环境：真实 ModelConfigStore + 注入依赖 + 假面板。 */
async function setup() {
	const messages: Record<string, unknown>[] = [];
	const modelStore = new ModelConfigStore({
		globalState: createMemoryMemento(),
		secrets: createMemorySecrets(),
	} as unknown as vscode.ExtensionContext, fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-model-switch-')));
	// 预置两个已启用模型：model-a 为默认，model-b 待切换
	await modelStore.save({ provider: 'openai', model: 'gpt-4o', baseURL: 'https://x/v1', temperature: 0.7, maxTokens: 4096, apiKey: 'sk-a' });
	await modelStore.save({ provider: 'openai', model: 'deepseek-chat', baseURL: 'https://ds/v1', temperature: 0.3, maxTokens: 2048, apiKey: 'sk-b' });
	const provider = new ChatViewProvider(
		{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
		{
			sessionManager: {} as unknown as LocalSessionManager,
			registry: {} as ToolRegistry,
			eventBus: { onAll: () => () => {} } as unknown as EventBus,
		}
	);
	const savedConfigs: unknown[] = [];
	provider.setSettingsDeps({
		modelStore,
		getSyncSource: () => 'claude' as SyncSource,
		getSkillDirectories: () => [],
		setSyncSource: async (source: SyncSource) => source,
		setSkillDirectories: async (directories: readonly string[]) => [...directories],
		getModelName: () => 'gpt-4o',
		uploadSkillArchive: async () => ({ ok: false, reason: '未使用' }),
		onModelConfigSaved: (config) => {
			savedConfigs.push(config);
		},
	});
	const internals = provider as unknown as PanelInternals;
	internals._chatWebview = {
		postMessage: (message: Record<string, unknown>) => messages.push(message),
	} as unknown as vscode.Webview;
	const view = await modelStore.getSettingsView();
	const modelA = view.models?.find((m) => m.model === 'gpt-4o');
	const modelB = view.models?.find((m) => m.model === 'deepseek-chat');
	return { messages, internals, modelStore, savedConfigs, modelA, modelB };
}

describe('ChatViewProvider /model 切换模型宿主处理', () => {
	it('返回已启用模型列表供对话面板的模型弹窗展示', async () => {
		const { internals, messages, modelA, modelB } = await setup();
		assert.ok(modelA);
		assert.ok(modelB);

		await internals._handleMessage({ command: 'requestModelPicker' });

		assert.deepStrictEqual(messages, [{
			command: 'modelPicker',
			models: [
				{ id: modelA!.id, model: 'gpt-4o', provider: 'openai', isDefault: true },
				{ id: modelB!.id, model: 'deepseek-chat', provider: 'openai', isDefault: false },
			],
		}]);
	});

	it('从对话面板模型弹窗选择模型后切换默认模型', async () => {
		const { internals, modelStore, savedConfigs, modelB } = await setup();
		assert.ok(modelB);

		await internals._handleMessage({ command: 'selectModel', modelId: modelB!.id });

		const view = await modelStore.getSettingsView();
		assert.strictEqual(view.defaultModelId, modelB!.id);
		assert.strictEqual(savedConfigs.length, 1);
	});

	it('选择模型后切换默认模型、触发 onModelConfigSaved 并携带密钥配置', async () => {
		const { internals, modelStore, savedConfigs, modelB } = await setup();
		assert.ok(modelB, '预置模型 model-b 应存在');
		const orig = vscode.window.showQuickPick;
		vscode.window.showQuickPick = (async () => ({
			label: 'deepseek-chat',
			description: 'openai',
			detail: '已配置 API Key',
			modelId: modelB!.id,
		})) as unknown as typeof vscode.window.showQuickPick;
		try {
			await internals._handleMessage({ command: 'switchModel' });
		} finally {
			vscode.window.showQuickPick = orig;
		}

		const view = await modelStore.getSettingsView();
		assert.strictEqual(view.defaultModelId, modelB!.id, '默认模型应切换为所选模型');
		assert.strictEqual(savedConfigs.length, 1, '切换成功应触发 onModelConfigSaved');
		const saved = savedConfigs[0] as { model: string; apiKey: string };
		assert.strictEqual(saved.model, 'deepseek-chat');
		assert.strictEqual(saved.apiKey, 'sk-b', '回调配置应包含 SecretStorage 密钥');
	});

	it('用户取消选择时不切换默认模型', async () => {
		const { internals, modelStore, savedConfigs, modelA } = await setup();
		assert.ok(modelA);
		const orig = vscode.window.showQuickPick;
		vscode.window.showQuickPick = (async () => undefined) as unknown as typeof vscode.window.showQuickPick;
		try {
			await internals._handleMessage({ command: 'switchModel' });
		} finally {
			vscode.window.showQuickPick = orig;
		}

		const view = await modelStore.getSettingsView();
		assert.strictEqual(view.defaultModelId, modelA!.id, '取消后默认模型保持不变');
		assert.strictEqual(savedConfigs.length, 0, '取消不应触发保存回调');
	});

	it('无可用模型时提示且不切换', async () => {
		const messages: Record<string, unknown>[] = [];
		const modelStore = new ModelConfigStore({
			globalState: createMemoryMemento(),
			secrets: createMemorySecrets(),
		} as unknown as vscode.ExtensionContext, fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-model-switch-')));
		const provider = new ChatViewProvider(
			{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
			{
				sessionManager: {} as unknown as LocalSessionManager,
				registry: {} as ToolRegistry,
				eventBus: { onAll: () => () => {} } as unknown as EventBus,
			}
		);
		const savedConfigs: unknown[] = [];
		provider.setSettingsDeps({
			modelStore,
			getSyncSource: () => 'claude' as SyncSource,
			getSkillDirectories: () => [],
			setSyncSource: async (source: SyncSource) => source,
			setSkillDirectories: async (directories: readonly string[]) => [...directories],
			getModelName: () => '',
			uploadSkillArchive: async () => ({ ok: false, reason: '未使用' }),
			onModelConfigSaved: (config) => {
				savedConfigs.push(config);
			},
		});
		const internals = provider as unknown as PanelInternals;
		internals._chatWebview = {
			postMessage: (message: Record<string, unknown>) => messages.push(message),
		} as unknown as vscode.Webview;

		let quickPickCalled = false;
		const origPick = vscode.window.showQuickPick;
		vscode.window.showQuickPick = ((() => {
			quickPickCalled = true;
			return undefined;
		}) as unknown) as typeof vscode.window.showQuickPick;
		const origInfo = vscode.window.showInformationMessage;
		vscode.window.showInformationMessage = (async () => undefined) as unknown as typeof vscode.window.showInformationMessage;
		try {
			await internals._handleMessage({ command: 'switchModel' });
		} finally {
			vscode.window.showQuickPick = origPick;
			vscode.window.showInformationMessage = origInfo;
		}

		assert.strictEqual(quickPickCalled, false, '无可用模型时不应弹出选择列表');
		assert.strictEqual(savedConfigs.length, 0, '无可用模型时不应触发保存回调');
	});
});
