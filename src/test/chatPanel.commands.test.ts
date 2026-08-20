/**
 * ChatViewProvider Command 宿主协议测试 - 覆盖发送时安全展开、失效拒绝、设置页快照与 CRUD 消息路由。
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
import { CommandStore } from '../command/commandStore';
import { CommandRegistry } from '../command/commandRegistry';
import type { CommandDirectories } from '../command/commandLoader';

interface PanelInternals {
	_chatWebview?: vscode.Webview;
	_settingsPanel?: vscode.WebviewPanel;
	_currentSessionId?: string;
	_handleMessage(msg: { command: string; [key: string]: unknown }): Promise<void>;
	_handleSettingsMessage(panel: vscode.WebviewPanel, msg: { command: string; [key: string]: unknown }): Promise<void>;
	setRuntimeStatus(status: 'initializing' | 'ready' | 'failed', message?: string): void;
}

/** 构造测试环境：真实 CommandStore（临时目录）+ 记录消息的假 Webview。 */
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-panel-'));
	const globalDir = path.join(root, 'global', '.yunForce', 'command');
	const projectDir = path.join(root, 'project', '.yunForce', 'command');
	const dirs: CommandDirectories = { globalDir, projectDir };
	const store = new CommandStore(dirs, new CommandRegistry());

	const messages: Record<string, unknown>[] = [];
	const sentTexts: string[] = [];
	const provider = new ChatViewProvider(
		{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
		{
			sessionManager: {
				createSession: () => 'new-session',
				sendMessage: (_sessionId: string, text: string) => {
					sentTexts.push(text);
				},
				loadHistory: () => [],
			} as unknown as LocalSessionManager,
			registry: {} as ToolRegistry,
			eventBus: { onAll: () => () => {} } as unknown as EventBus,
		},
	);
	provider.setCommandStore(store);
	// 设置面板依赖：Command 消息路由仅需 deps 存在，具体字段由 CommandStore 提供
	provider.setSettingsDeps({
		modelStore: {} as never,
		getSyncSource: () => 'claude',
		getSkillDirectories: () => [],
		setSyncSource: async () => 'claude',
		setSkillDirectories: async () => [],
		getModelName: () => '',
		uploadSkillArchive: async () => ({ ok: false, reason: '未配置' }),
	} as never);
	const internals = provider as unknown as PanelInternals;
	internals._chatWebview = {
		postMessage: (message: Record<string, unknown>) => messages.push(message),
	} as unknown as vscode.Webview;
	internals.setRuntimeStatus('ready');
	internals._currentSessionId = 'old-session';
	return { root, globalDir, projectDir, store, messages, sentTexts, internals, provider };
}

/** 最近一条指定命令的消息。 */
function lastMessage(messages: Record<string, unknown>[], command: string): Record<string, unknown> | undefined {
	return [...messages].reverse().find((m) => m.command === command);
}

/** 记录 postMessage 的假 WebviewPanel。 */
function createFakePanel(messages: Record<string, unknown>[]): vscode.WebviewPanel {
	return {
		webview: { postMessage: (m: Record<string, unknown>) => messages.push(m) },
	} as unknown as vscode.WebviewPanel;
}

describe('ChatViewProvider 发送时 Command 安全展开', () => {
	it('携带 Command 引用发送：以最新注册表正文 + 用户补充说明按边界组装', async () => {
		const { store, sentTexts, internals } = setup();
		await store.create('global', { name: 'review', description: '审查', body: '请审查当前改动' });
		await internals._handleMessage({
			command: 'sendMessage',
			sessionId: 'old-session',
			text: '重点检查并发问题',
			files: [],
			skills: [],
			commandRef: { name: 'review', scope: 'global' },
		});
		assert.strictEqual(sentTexts.length, 1);
		assert.match(sentTexts[0], /^\[Command: review\]\n请审查当前改动\n\n\[用户补充说明\]\n重点检查并发问题$/);
	});

	it('携带 Command 引用且无补充文本：省略补充说明区块', async () => {
		const { store, sentTexts, internals } = setup();
		await store.create('global', { name: 'review', body: '请审查当前改动' });
		await internals._handleMessage({
			command: 'sendMessage',
			sessionId: 'old-session',
			text: '',
			files: [],
			skills: [],
			commandRef: { name: 'review', scope: 'global' },
		});
		assert.strictEqual(sentTexts.length, 1);
		assert.strictEqual(sentTexts[0], '[Command: review]\n请审查当前改动');
	});

	it('项目覆盖全局：发送时使用项目正文', async () => {
		const { store, sentTexts, internals } = setup();
		await store.create('global', { name: 'review', body: '全局正文' });
		await store.create('project', { name: 'review', body: '项目正文' });
		await internals._handleMessage({
			command: 'sendMessage',
			sessionId: 'old-session',
			text: '',
			files: [],
			skills: [],
			commandRef: { name: 'review', scope: 'global' },
		});
		assert.strictEqual(sentTexts.length, 1);
		assert.match(sentTexts[0], /项目正文/);
	});

	it('命令已失效：拒绝发送、回传中文错误且不调用 sendMessage', async () => {
		const { sentTexts, messages, internals } = setup();
		await internals._handleMessage({
			command: 'sendMessage',
			sessionId: 'old-session',
			text: '补充',
			files: [],
			skills: [],
			commandRef: { name: 'gone', scope: 'global' },
		});
		assert.strictEqual(sentTexts.length, 0, '不得追加会话消息');
		const err = lastMessage(messages, 'error');
		assert.ok(err, '应回传错误');
		assert.match(String(err?.message), /gone 已不存在或无效/);
	});

	it('不信任 Webview 传入正文：始终以注册表正文为准（传入 body 字段被忽略）', async () => {
		const { store, sentTexts, internals } = setup();
		await store.create('global', { name: 'review', body: '注册表正文' });
		await internals._handleMessage({
			command: 'sendMessage',
			sessionId: 'old-session',
			text: '',
			files: [],
			skills: [],
			commandRef: { name: 'review', scope: 'global', body: '伪造正文' },
		});
		assert.strictEqual(sentTexts.length, 1);
		assert.match(sentTexts[0], /注册表正文/);
		assert.ok(!sentTexts[0].includes('伪造正文'), '不得使用 Webview 传入正文');
	});

	it('无 Command 引用时保持既有组装行为（Skill + 文件上下文）', async () => {
		const { sentTexts, internals } = setup();
		await internals._handleMessage({
			command: 'sendMessage',
			sessionId: 'old-session',
			text: 'hello',
			files: [],
			skills: ['plan'],
		});
		assert.strictEqual(sentTexts.length, 1);
		assert.strictEqual(sentTexts[0], '/plan\n\nhello');
	});
});

describe('ChatViewProvider 设置页 Command 消息路由', () => {
	it('requestCommands 返回双作用域快照（含覆盖标记与目录）', async () => {
		const { store, internals, provider } = setup();
		await store.create('global', { name: 'review', body: 'g' });
		await store.create('project', { name: 'review', body: 'p' });
		await store.create('project', { name: 'only-p', body: 'p2' });
		const messages: Record<string, unknown>[] = [];
		const panel = createFakePanel(messages);
		(provider as unknown as { _settingsPanel: vscode.WebviewPanel })._settingsPanel = panel;
		await internals._handleSettingsMessage(panel, { command: 'requestCommands' });

		const msg = lastMessage(messages, 'commandsList');
		assert.ok(msg, '应返回 commandsList');
		const global = msg?.global as { name: string; overridden: boolean }[];
		const project = msg?.project as { name: string; overridden: boolean }[];
		assert.strictEqual(global.length, 1);
		assert.strictEqual(global[0].overridden, true, '被项目覆盖的全局项应标记 overridden');
		assert.strictEqual(project.length, 2);
		assert.strictEqual(msg?.projectAvailable, true);
		assert.ok(msg?.globalDirectory);
		assert.ok(msg?.projectDirectory);
	});

	it('createCommand 成功后回推最新快照（且快照不含正文）', async () => {
		const { internals, provider } = setup();
		const messages: Record<string, unknown>[] = [];
		const panel = createFakePanel(messages);
		(provider as unknown as { _settingsPanel: vscode.WebviewPanel })._settingsPanel = panel;
		await internals._handleSettingsMessage(panel, {
			command: 'createCommand',
			scope: 'global',
			input: { name: 'new-cmd', description: '新命令', body: '新命令正文' },
		});
		const msg = lastMessage(messages, 'commandsList');
		assert.ok(msg);
		const global = msg?.global as { name: string; sourcePath: string }[];
		assert.strictEqual(global[0]?.name, 'new-cmd');
		assert.ok(!JSON.stringify(msg).includes('新命令正文'), '快照不得携带 Command 正文');
	});

	it('非法名称创建：回传 settingsError 且不生成文件', async () => {
		const { root, internals, provider } = setup();
		const messages: Record<string, unknown>[] = [];
		const panel = createFakePanel(messages);
		(provider as unknown as { _settingsPanel: vscode.WebviewPanel })._settingsPanel = panel;
		await internals._handleSettingsMessage(panel, {
			command: 'createCommand',
			scope: 'global',
			input: { name: 'bad/name', body: 'x' },
		});
		const err = lastMessage(messages, 'settingsError');
		assert.ok(err, '应回传 settingsError');
		assert.match(String(err?.message), /命令名不合法/);
		assert.ok(!fs.existsSync(path.join(root, 'global')), '非法名称不得创建目录');
	});

	it('deleteCommand 后快照移除对应项', async () => {
		const { store, internals, provider } = setup();
		await store.create('global', { name: 'review', body: 'g' });
		const messages: Record<string, unknown>[] = [];
		const panel = createFakePanel(messages);
		(provider as unknown as { _settingsPanel: vscode.WebviewPanel })._settingsPanel = panel;
		await internals._handleSettingsMessage(panel, { command: 'deleteCommand', scope: 'global', name: 'review' });
		const msg = lastMessage(messages, 'commandsList');
		assert.strictEqual((msg?.global as unknown[]).length, 0);
	});

	it('无工作区时项目作用域写操作回传中文错误', async () => {
		// 构造无项目目录的 store
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-panel-nws-'));
		const store = new CommandStore(
			{ globalDir: path.join(root, 'global', '.yunForce', 'command') },
			new CommandRegistry(),
		);
		const messages: Record<string, unknown>[] = [];
		const provider = new ChatViewProvider(
			{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
			{
				sessionManager: {} as unknown as LocalSessionManager,
				registry: {} as ToolRegistry,
				eventBus: { onAll: () => () => {} } as unknown as EventBus,
			},
		);
		provider.setCommandStore(store);
		provider.setSettingsDeps({
			modelStore: {} as never,
			getSyncSource: () => 'claude',
			getSkillDirectories: () => [],
			setSyncSource: async () => 'claude',
			setSkillDirectories: async () => [],
			getModelName: () => '',
			uploadSkillArchive: async () => ({ ok: false, reason: '未配置' }),
		} as never);
		const internals = provider as unknown as PanelInternals;
		const panel = createFakePanel(messages);
		(provider as unknown as { _settingsPanel: vscode.WebviewPanel })._settingsPanel = panel;
		await internals._handleSettingsMessage(panel, {
			command: 'createCommand',
			scope: 'project',
			input: { name: 'x', body: 'y' },
		});
		const err = lastMessage(messages, 'settingsError');
		assert.ok(err);
		assert.match(String(err?.message), /未打开工作区/);
	});
});

describe('ChatViewProvider Command 端到端场景', () => {
	it('设置页创建全局 → 项目同名覆盖 → 聊天选择并补充文字，发送最新项目正文', async () => {
		const { internals, provider, sentTexts } = setup();
		const settingsMessages: Record<string, unknown>[] = [];
		const panel = createFakePanel(settingsMessages);
		(provider as unknown as { _settingsPanel: vscode.WebviewPanel })._settingsPanel = panel;

		// 1) 设置页创建全局 Command
		await internals._handleSettingsMessage(panel, {
			command: 'createCommand',
			scope: 'global',
			input: { name: 'review', body: '全局审查正文' },
		});
		let msg = lastMessage(settingsMessages, 'commandsList');
		assert.strictEqual((msg?.global as { name: string }[]).length, 1);
		assert.ok(!JSON.stringify(msg).includes('全局审查正文'), '设置页快照不携带正文');

		// 2) 项目同名覆盖
		await internals._handleSettingsMessage(panel, {
			command: 'createCommand',
			scope: 'project',
			input: { name: 'review', body: '项目审查正文' },
		});
		msg = lastMessage(settingsMessages, 'commandsList');
		const globalInfo = (msg?.global as { name: string; overridden: boolean }[])[0];
		assert.strictEqual(globalInfo.overridden, true, '全局项应标记被项目覆盖');

		// 3) 聊天选择 /review 并补充文字后发送：使用项目正文 + 补充说明
		await internals._handleMessage({
			command: 'sendMessage',
			sessionId: 'old-session',
			text: '重点检查并发问题',
			files: [],
			skills: [],
			commandRef: { name: 'review', scope: 'global' },
		});
		assert.strictEqual(sentTexts.length, 1);
		assert.strictEqual(
			sentTexts[0],
			'[Command: review]\n项目审查正文\n\n[用户补充说明]\n重点检查并发问题',
		);
	});
});
