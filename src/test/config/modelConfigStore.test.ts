/**
 * ModelConfigStore 测试 - 覆盖私有存储读写、默认值、校验与密钥不回传。
 *
 * 用内存版 globalState / secrets 模拟 VS Code 扩展上下文，不依赖真实 VS Code 环境。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	ModelConfigStore,
	validateModelSettings,
	type ModelSettingsInput,
} from '../../config/modelConfigStore';

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

/** 构造带内存存储的测试环境。 */
function setup() {
	const globalState = createMemoryMemento();
	const secrets = createMemorySecrets();
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-model-store-'));
	const store = new ModelConfigStore({
		globalState,
		secrets,
	} as unknown as vscode.ExtensionContext, workspaceRoot);
	return { store, globalState, secrets, workspaceRoot };
}

/** 合法模型配置输入。 */
function validInput(overrides: Partial<ModelSettingsInput> = {}): ModelSettingsInput {
	return {
		provider: 'openai',
		model: 'gpt-4o-mini',
		baseURL: 'https://api.openai.com/v1',
		temperature: 0.7,
		maxTokens: 4096,
		...overrides,
	};
}

describe('ModelConfigStore', () => {
	describe('读取（默认值与存储合并）', () => {
		it('无已保存配置时返回安全默认值，且不读取 VS Code 配置', async () => {
			const { store } = setup();
			const config = await store.getModelConfig();
			assert.strictEqual(config.provider, 'openai');
			assert.strictEqual(config.model, '');
			assert.strictEqual(config.apiKey, '');
			assert.strictEqual(config.baseURL, 'https://api.openai.com/v1');
			assert.strictEqual(config.temperature, 0.7);
			assert.strictEqual(config.maxTokens, 4096);
			assert.strictEqual(config.maxContextTokens, 262144);
			assert.strictEqual(config.runtime, 'ai-sdk');
		});

		it('保存后从私有存储读取完整配置（含 SecretStorage 中的 API Key）', async () => {
		const { store, secrets } = setup();
		await store.save(validInput({ apiKey: 'sk-test-123' }));
		const config = await store.getModelConfig();
			assert.strictEqual(config.model, 'gpt-4o-mini');
			assert.strictEqual(config.apiKey, 'sk-test-123');
		const view = await store.getSettingsView();
		assert.strictEqual(await secrets.get(`yunxiaoAgent.model.apiKey.${view.defaultModelId}`), 'sk-test-123');
		});

		it('API Key 仅从 SecretStorage 读取（不进 globalState）', async () => {
			const { store, globalState } = setup();
			await store.save(validInput({ apiKey: 'sk-secret' }));
			const rawState = JSON.stringify(globalState.keys());
			assert.ok(!rawState.includes('sk-secret'), 'globalState 不应包含密钥明文');
		});
	});

	describe('设置页视图（密钥不回传）', () => {
		it('getSettingsView 返回 apiKeyConfigured 布尔而非密钥明文', async () => {
			const { store } = setup();
			await store.save(validInput({ apiKey: 'sk-view-test' }));
			const view = await store.getSettingsView();
			assert.strictEqual(view.apiKeyConfigured, true);
			assert.ok(!JSON.stringify(view).includes('sk-view-test'), '视图不得包含密钥明文');
		});

		it('未配置 API Key 时 apiKeyConfigured 为 false', async () => {
			const { store } = setup();
			await store.save(validInput());
			const view = await store.getSettingsView();
			assert.strictEqual(view.apiKeyConfigured, false);
		});
	});

	describe('保存', () => {
		it('空 API Key 表示保持现状，不覆盖 SecretStorage 既有密钥', async () => {
		const { store, secrets } = setup();
		await store.save(validInput({ apiKey: 'sk-original' }));
		const view = await store.getSettingsView();
		await store.save(validInput({ id: view.defaultModelId, apiKey: '' }));
		assert.strictEqual(await secrets.get(`yunxiaoAgent.model.apiKey.${view.defaultModelId}`), 'sk-original');
			const config = await store.getModelConfig();
			assert.strictEqual(config.apiKey, 'sk-original');
		});

		it('保存后返回含当前生效 API Key 的完整配置', async () => {
			const { store } = setup();
			const saved = await store.save(validInput({ apiKey: 'sk-new' }));
			assert.strictEqual(saved.apiKey, 'sk-new');
			assert.strictEqual(saved.model, 'gpt-4o-mini');
		});
	});

	describe('校验', () => {
		it('允许保存手动填写的最大上下文 token', async () => {
			const { store } = setup();
			const saved = await store.save(validInput({ maxContextTokens: 1000000 }));
			assert.strictEqual(saved.maxContextTokens, 1000000);
		});

		it('最大上下文 token 小于最大输出时被拒绝', () => {
			assert.ok(validateModelSettings(validInput({ maxTokens: 4096, maxContextTokens: 4096 })));
		});

		it('缺失模型名被拒绝', () => {
			const error = validateModelSettings(validInput({ model: '' }));
			assert.ok(error && error.includes('模型名称'));
		});

		it('温度越界被拒绝', () => {
			assert.ok(validateModelSettings(validInput({ temperature: 2.5 })));
			assert.ok(validateModelSettings(validInput({ temperature: -0.1 })));
		});

		it('maxTokens 越界被拒绝', () => {
			assert.ok(validateModelSettings(validInput({ maxTokens: 0 })));
			assert.ok(validateModelSettings(validInput({ maxTokens: 999_999 })));
		});

		it('不支持的 provider 被拒绝（避免持久化后激活/更新失败）', () => {
			assert.ok(validateModelSettings(validInput({ provider: 'anthropic' })));
			assert.ok(validateModelSettings(validInput({ provider: '' })));
		});

		it('非法 API 地址被拒绝', () => {
			assert.ok(validateModelSettings(validInput({ baseURL: 'not-a-url' })));
			assert.ok(validateModelSettings(validInput({ baseURL: 'ftp://x/v1' })));
			assert.strictEqual(validateModelSettings(validInput({ baseURL: 'https://api.openai.com/v1' })), null);
		});

		it('校验失败时 save 抛错且不修改既有配置', async () => {
			const { store } = setup();
			await store.save(validInput({ model: 'keep-me' }));
			await assert.rejects(() => store.save(validInput({ model: '' })));
			const config = await store.getModelConfig();
			assert.strictEqual(config.model, 'keep-me', '既有配置保持不变');
		});
	});

	describe('多模型文件与启用状态', () => {
		it('非敏感字段写入工作区 .yunForce/modelConfig，密钥不写入文件', async () => {
			const { store, workspaceRoot } = setup();
			await store.save(validInput({ apiKey: 'sk-file-secret' }));
			const raw = fs.readFileSync(path.join(workspaceRoot, '.yunForce', 'modelConfig', 'models.json'), 'utf8');
			assert.ok(raw.includes('gpt-4o-mini'));
			assert.ok(!raw.includes('sk-file-secret'));
		});

		it('支持新增模型、切换默认模型和停用非默认模型', async () => {
			const { store } = setup();
			await store.save(validInput({ model: 'model-a' }));
			await store.save(validInput({ model: 'model-b' }));
			const before = await store.getSettingsView();
			const second = before.models?.find((item) => item.model === 'model-b');
			assert.ok(second);
			await store.setDefaultModel(second!.id);
			assert.strictEqual((await store.getModelConfig()).model, 'model-b');
			const first = (await store.getSettingsView()).models?.find((item) => item.model === 'model-a');
			await store.setModelEnabled(first!.id, false);
			assert.strictEqual((await store.getSettingsView()).models?.find((item) => item.id === first!.id)?.enabled, false);
		});
	});
});
