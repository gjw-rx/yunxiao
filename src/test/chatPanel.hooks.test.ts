/**
 * Hooks 设置面板宿主协议测试 - 覆盖快照请求、配置保存（含入站字段校验）、
 * RTK 检测与固定样例改写测试的消息路由。
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../chatPanel';
import type { LocalSessionManager } from '../core/localSessionManager';
import type { ToolRegistry } from '../core/toolRegistry';
import type { EventBus } from '../core/eventBus';
import { HooksConfigStore, MementoHooksConfigStorage } from '../hook/hooksConfigStore';
import type { RtkTransformHook } from '../hook/rtkAdapter';
import type { RtkDetectionResult } from '../hook/rtkDetector';

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

/** 记录 postMessage 的假 WebviewPanel。 */
function createFakePanel(messages: Record<string, unknown>[]): vscode.WebviewPanel {
	return {
		webview: { postMessage: (m: Record<string, unknown>) => messages.push(m) },
	} as unknown as vscode.WebviewPanel;
}

/** 构造 Hooks 设置面板宿主测试环境。 */
function setup(overrides: {
	detectResult?: RtkDetectionResult;
	testRewrite?: { sample: string; rewritten?: string; error?: string };
} = {}) {
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
	const hooksConfigStore = new HooksConfigStore(
		new MementoHooksConfigStorage(createMemoryMemento() as never)
	);
	provider.setSettingsDeps({
		modelStore: {} as never,
		getSyncSource: () => 'none',
		getSkillDirectories: () => [],
		setSyncSource: async (source) => source,
		setSkillDirectories: async (directories) => [...directories],
		getModelName: () => '',
		uploadSkillArchive: async () => ({ ok: false, reason: '未实现' }),
		hooksConfigStore,
		detectRtk: async (path: string): Promise<RtkDetectionResult> =>
			overrides.detectResult ?? { available: true, version: 'rtk 1.0.0' },
		rtkTransformHook: {
			testRewrite: async () => overrides.testRewrite ?? { sample: 'git status', rewritten: 'rtk git status' },
		} as unknown as RtkTransformHook,
	});
	const internals = provider as unknown as SettingsInternals;
	return { messages, panel, internals, hooksConfigStore };
}

/** 最近一条指定命令的消息。 */
function lastMessage(messages: Record<string, unknown>[], command: string): Record<string, unknown> | undefined {
	return [...messages].reverse().find((m) => m.command === command);
}

describe('ChatViewProvider Hooks 宿主协议', () => {
	it('requestHooksSnapshot 返回安全默认配置且不含 rtk 状态（未检测）', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, { command: 'requestHooksSnapshot' });
		const msg = lastMessage(messages, 'hooksSnapshot');
		assert.ok(msg, '应返回 hooksSnapshot');
		const config = msg?.config as Record<string, unknown>;
		assert.strictEqual(config.enabled, true);
		assert.strictEqual(config.rtkEnabled, false); // 安全默认：RTK 禁用
		assert.strictEqual(msg?.rtk, undefined);
	});

	it('saveHooksConfig 非法字段返回 settingsError 且不持久化', async () => {
		const { messages, panel, internals, hooksConfigStore } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveHooksConfig',
			enabled: 'yes', // 非法：非 boolean
			rtkEnabled: false,
		});
		const msg = lastMessage(messages, 'settingsError');
		assert.ok(msg, '应返回 settingsError');
		assert.ok(String(msg?.message).includes('字段非法'));
		assert.strictEqual(hooksConfigStore.get().enabled, true); // 未持久化
	});

	it('saveHooksConfig 合法：持久化并回推快照，路径 trim 且清除旧检测状态', async () => {
		const { messages, panel, internals, hooksConfigStore } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveHooksConfig',
			enabled: true,
			rtkEnabled: true,
			rtkExecutablePath: '  C:\\tools\\rtk.exe  ',
		});
		const saved = hooksConfigStore.get();
		assert.strictEqual(saved.rtk.enabled, true);
		assert.strictEqual(saved.rtk.executablePath, 'C:\\tools\\rtk.exe');
		const msg = lastMessage(messages, 'hooksSnapshot');
		assert.ok(msg, '应返回 hooksSnapshot');
		const config = msg?.config as Record<string, unknown>;
		assert.strictEqual(config.rtkEnabled, true);
		assert.strictEqual(config.rtkExecutablePath, 'C:\\tools\\rtk.exe');
	});

	it('detectRtk 未配置路径返回 settingsError', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, { command: 'detectRtk' });
		const msg = lastMessage(messages, 'settingsError');
		assert.ok(msg, '应返回 settingsError');
		assert.ok(String(msg?.message).includes('路径'));
	});

	it('detectRtk 成功：缓存有界状态并随快照回推', async () => {
		const { messages, panel, internals, hooksConfigStore } = setup({
			detectResult: { available: true, version: 'rtk 2.0.0' },
		});
		await hooksConfigStore.save({ rtk: { enabled: true, executablePath: 'C:\\tools\\rtk.exe' } });
		await internals._handleSettingsMessage(panel, { command: 'detectRtk' });
		const msg = lastMessage(messages, 'hooksSnapshot');
		assert.ok(msg, '应返回 hooksSnapshot');
		const rtk = msg?.rtk as Record<string, unknown>;
		assert.strictEqual(rtk.available, true);
		assert.strictEqual(rtk.version, 'rtk 2.0.0');
		assert.ok(typeof rtk.lastDetectedAt === 'number');
	});

	it('detectRtk 失败：返回有界错误摘要（不含完整命令输出）', async () => {
		const { messages, panel, internals, hooksConfigStore } = setup({
			detectResult: { available: false, error: '无法启动 RTK 可执行文件: ENOENT' },
		});
		await hooksConfigStore.save({ rtk: { enabled: true, executablePath: 'C:\\missing\\rtk.exe' } });
		await internals._handleSettingsMessage(panel, { command: 'detectRtk' });
		const msg = lastMessage(messages, 'hooksSnapshot');
		const rtk = msg?.rtk as Record<string, unknown>;
		assert.strictEqual(rtk.available, false);
		assert.strictEqual(rtk.error, '无法启动 RTK 可执行文件: ENOENT');
	});

	it('testRtkRewrite：回推样例与改写结果', async () => {
		const { messages, panel, internals } = setup({
			testRewrite: { sample: 'git status', rewritten: 'rtk git status' },
		});
		await internals._handleSettingsMessage(panel, { command: 'testRtkRewrite' });
		const msg = lastMessage(messages, 'hooksTestResult');
		assert.ok(msg, '应返回 hooksTestResult');
		assert.strictEqual(msg?.sample, 'git status');
		assert.strictEqual(msg?.rewritten, 'rtk git status');
	});

	it('testRtkRewrite 失败：回推有界错误', async () => {
		const { messages, panel, internals } = setup({
			testRewrite: { sample: 'git status', error: 'RTK 不可用或无改写结果' },
		});
		await internals._handleSettingsMessage(panel, { command: 'testRtkRewrite' });
		const msg = lastMessage(messages, 'hooksTestResult');
		assert.ok(msg, '应返回 hooksTestResult');
		assert.strictEqual(msg?.error, 'RTK 不可用或无改写结果');
	});
});
