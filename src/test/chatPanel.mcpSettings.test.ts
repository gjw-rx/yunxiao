/**
 * MCP 设置面板宿主协议测试（任务 4.2）。
 *
 * 覆盖：请求快照、JSON 新增/编辑保存、字段错误 fieldPath、伪造/缺失 Server ID、
 * 启停、重连、删除与操作已接受反馈；并验证 env/header 明文永不回传 Webview。
 *
 * 使用真实 McpConfigStore（内存 secrets + 临时目录）验证持久化与字段校验链路，
 * getMcpSnapshot 以 Store 配置视图 + 可控状态映射模拟 Manager 运行时状态。
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
import { McpConfigStore } from '../mcp/configStore';
import type { McpServerView, McpServerStatus } from '../mcp/types';

interface SettingsInternals {
	_handleSettingsMessage(
		panel: vscode.WebviewPanel,
		msg: { command: string;[key: string]: unknown }
	): Promise<void>;
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

/** 合法 STDIO JSON（带 env 明文，用于验证秘密不回传）。 */
const STDIO_JSON_WITH_ENV = JSON.stringify({
	mcpServers: {
		codegraph: {
			type: 'stdio',
			command: 'codegraph',
			args: ['serve', '--mcp'],
			env: { API_TOKEN: 'sk-secret-value' },
			enabled: true,
		},
	},
});

/** 合法 Streamable HTTP JSON（带 header 明文）。 */
const HTTP_JSON_WITH_HEADER = JSON.stringify({
	mcpServers: {
		'remote-docs': {
			type: 'streamable-http',
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer secret-bearer' },
			enabled: true,
		},
	},
});

/** 缺少 command 的非法 STDIO JSON。 */
const STDIO_MISSING_COMMAND = JSON.stringify({
	mcpServers: {
		bad: { type: 'stdio' },
	},
});

/** 无法解析的 JSON 文本。 */
const INVALID_JSON = '{ not valid json';

/** 最近一条指定命令的消息。 */
function lastMessage(messages: Record<string, unknown>[], command: string): Record<string, unknown> | undefined {
	return [...messages].reverse().find((m) => m.command === command);
}

/** 构造 MCP 设置面板宿主测试环境（真实 McpConfigStore + 内存 secrets + 快照模拟）。 */
function setup(options?: { readonly onMcpConfigChanged?: () => Promise<void> }) {
	const messages: Record<string, unknown>[] = [];
	const globalConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-host-'));
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunxiao-mcp-ws-'));
	const secrets = createMemorySecrets();
	const mcpStore = new McpConfigStore(
		{ secrets } as unknown as vscode.ExtensionContext,
		globalConfigRoot,
		[workspaceRoot],
	);
	const panel = createFakePanel(messages);
	const configChangedCalls: number[] = [];
	const reconnectCalls: string[] = [];
	/** 可覆盖的状态映射：serverId → 运行时状态。 */
	const statusMap = new Map<string, McpServerStatus>();

	/** 从 Store 配置视图构建非敏感快照（模拟 Manager 合并运行时状态）。 */
	async function getMcpSnapshot(): Promise<readonly McpServerView[]> {
		const entries = await mcpStore.getSettingsView();
		return entries.map((entry) => {
			const status: McpServerStatus = statusMap.get(entry.id) ?? (entry.config.enabled ? 'ready' : 'disabled');
			return {
				id: entry.id,
				configuredTransport: entry.config.type,
				actualTransport: status === 'ready' ? entry.config.type : undefined,
				enabled: entry.config.enabled,
				status,
				toolCount: status === 'ready' ? 1 : 0,
				tools: status === 'ready' ? [{ name: 'native_tool', description: '示例工具' }] : [],
				config: entry.config,
			} satisfies McpServerView;
		});
	}

	const provider = new ChatViewProvider(
		{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
		{
			sessionManager: {} as unknown as LocalSessionManager,
			registry: {} as ToolRegistry,
			eventBus: { onAll: () => () => { } } as unknown as EventBus,
		},
	);
	provider.setSettingsDeps({
		modelStore: undefined as never,
		getSyncSource: () => 'none',
		getSkillDirectories: () => [],
		setSyncSource: async (source) => source,
		setSkillDirectories: async (directories) => [...directories],
		getModelName: () => 'test-model',
		uploadSkillArchive: async () => ({ ok: false, reason: '未启用' }),
		mcpStore,
		getMcpSnapshot,
		onMcpConfigChanged: async () => {
			configChangedCalls.push(1);
			await options?.onMcpConfigChanged?.();
		},
		onMcpReconnect: (serverId: string) => {
			reconnectCalls.push(serverId);
		},
	});
	const internals = provider as unknown as SettingsInternals;
	return {
		messages,
		panel,
		internals,
		mcpStore,
		statusMap,
		configChangedCalls,
		reconnectCalls,
	};
}

describe('ChatViewProvider MCP 设置面板宿主协议', () => {
	it('requestMcpSettings 返回 getMcpSnapshot 快照且不含秘密明文', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, { command: 'requestMcpSettings' });

		const msg = lastMessage(messages, 'mcpSettings');
		assert.ok(msg, '应返回 mcpSettings');
		assert.ok(Array.isArray(msg?.servers), 'servers 应为数组');
	});

	it('requestMcpSettings 未装配 getMcpSnapshot 时返回空快照不抛错', async () => {
		const messages: Record<string, unknown>[] = [];
		const panel = createFakePanel(messages);
		const provider = new ChatViewProvider(
			{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
			{
				sessionManager: {} as unknown as LocalSessionManager,
				registry: {} as ToolRegistry,
				eventBus: { onAll: () => () => { } } as unknown as EventBus,
			},
		);
		provider.setSettingsDeps({
			modelStore: undefined as never,
			getSyncSource: () => 'none',
			getSkillDirectories: () => [],
			setSyncSource: async (s) => s,
			setSkillDirectories: async (d) => [...d],
			getModelName: () => 'test',
			uploadSkillArchive: async () => ({ ok: false, reason: 'x' }),
			mcpStore: undefined,
			getMcpSnapshot: undefined,
		});
		const internals = provider as unknown as SettingsInternals;
		await internals._handleSettingsMessage(panel, { command: 'requestMcpSettings' });

		const msg = lastMessage(messages, 'mcpSettings');
		assert.ok(msg, '未装配快照也应返回 mcpSettings');
		assert.deepStrictEqual(msg?.servers, []);
	});

	it('saveMcpServersJson add 模式成功：回推 mcpSettingsSaved 并通知运行时', async () => {
		const { messages, panel, internals, configChangedCalls } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveMcpServersJson',
			json: STDIO_JSON_WITH_ENV,
			mode: 'add',
		});

		const msg = lastMessage(messages, 'mcpSettingsSaved');
		assert.ok(msg, '应返回 mcpSettingsSaved');
		const servers = msg?.servers as McpServerView[];
		assert.ok(servers.some((s) => s.id === 'codegraph'), '快照应含新保存的 Server');
		assert.strictEqual(configChangedCalls.length, 1, '应通知运行时应用新 revision');
	});

	it('saveMcpServersJson 成功后 env 明文不回传 Webview', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveMcpServersJson',
			json: STDIO_JSON_WITH_ENV,
			mode: 'add',
		});

		const msg = lastMessage(messages, 'mcpSettingsSaved');
		assert.ok(!JSON.stringify(msg).includes('sk-secret-value'), 'env 明文不得回传');
		const servers = msg?.servers as McpServerView[];
		const cg = servers.find((s) => s.id === 'codegraph');
		assert.ok(cg?.config.type === 'stdio' && cg.config.envKeys.includes('API_TOKEN'), '应只暴露 envKeys');
	});

	it('saveMcpServersJson 等待运行时配置应用完成后再返回快照', async () => {
		let statusMap: Map<string, McpServerStatus>;
		let resolveRuntimeApply: (() => void) | undefined;
		let notifyRuntimeApplyStarted: (() => void) | undefined;
		const runtimeApplyStarted = new Promise<void>((resolve) => {
			notifyRuntimeApplyStarted = resolve;
		});
		const runtimeApply = new Promise<void>((resolve) => {
			resolveRuntimeApply = resolve;
		});
		const result = setup({
			onMcpConfigChanged: async () => {
				notifyRuntimeApplyStarted?.();
				await runtimeApply;
				statusMap.set('codegraph', 'ready');
			},
		});
		statusMap = result.statusMap;
		statusMap.set('codegraph', 'connecting');

		const save = result.internals._handleSettingsMessage(result.panel, {
			command: 'saveMcpServersJson',
			json: STDIO_JSON_WITH_ENV,
			mode: 'add',
		});
		await runtimeApplyStarted;
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(lastMessage(result.messages, 'mcpSettingsSaved'), undefined, '运行时未完成时不应回传快照');
		resolveRuntimeApply?.();
		await save;

		const msg = lastMessage(result.messages, 'mcpSettingsSaved');
		const servers = msg?.servers as McpServerView[];
		assert.strictEqual(servers.find((server) => server.id === 'codegraph')?.status, 'ready');
	});

	it('saveMcpServersJson edit 模式成功：更新指定 Server', async () => {
		const { messages, panel, internals, mcpStore } = setup();
		// 先新增一个 Server
		await mcpStore.saveAddImport(HTTP_JSON_WITH_HEADER);
		// 编辑该 Server（header 用占位保留）
		const editJson = JSON.stringify({
			mcpServers: {
				'remote-docs': {
					type: 'streamable-http',
					url: 'https://example.com/mcp',
					headers: { Authorization: '<已安全保存>' },
					enabled: false,
				},
			},
		});
		await internals._handleSettingsMessage(panel, {
			command: 'saveMcpServersJson',
			json: editJson,
			mode: 'edit',
			editingServerId: 'remote-docs',
		});

		const msg = lastMessage(messages, 'mcpSettingsSaved');
		assert.ok(msg, 'edit 成功应回推 mcpSettingsSaved');
		const servers = msg?.servers as McpServerView[];
		const remote = servers.find((s) => s.id === 'remote-docs');
		assert.strictEqual(remote?.enabled, false, '编辑应更新 enabled');
	});

	it('saveMcpServersJson edit 模式缺 editingServerId：返回字段错误', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveMcpServersJson',
			json: STDIO_JSON_WITH_ENV,
			mode: 'edit',
		});

		const msg = lastMessage(messages, 'mcpSettingsError');
		assert.ok(msg, '应返回 mcpSettingsError');
		assert.strictEqual(msg?.operation, 'save');
		assert.ok(String(msg?.message).includes('editingServerId'), '应提示缺少 editingServerId');
	});

	it('saveMcpServersJson 字段错误：返回带 fieldPath 的 mcpSettingsError', async () => {
		const { messages, panel, internals, configChangedCalls } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveMcpServersJson',
			json: STDIO_MISSING_COMMAND,
			mode: 'add',
		});

		const msg = lastMessage(messages, 'mcpSettingsError');
		assert.ok(msg, '字段错误应返回 mcpSettingsError');
		assert.strictEqual(msg?.operation, 'save');
		assert.ok(msg?.fieldPath, '应携带 fieldPath');
		assert.ok(String(msg?.fieldPath).includes('bad'), 'fieldPath 应定位到出错 Server');
		assert.strictEqual(configChangedCalls.length, 0, '校验失败不得通知运行时');
	});

	it('saveMcpServersJson JSON 语法错误：返回 mcpSettingsError 且不持久化', async () => {
		const { messages, panel, internals, mcpStore } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveMcpServersJson',
			json: INVALID_JSON,
			mode: 'add',
		});

		const msg = lastMessage(messages, 'mcpSettingsError');
		assert.ok(msg, '语法错误应返回 mcpSettingsError');
		const doc = await mcpStore.getDocument();
		assert.strictEqual(Object.keys(doc.servers).length, 0, '语法错误不得持久化');
	});

	it('saveMcpServersJson 未装配 mcpStore：返回未就绪错误', async () => {
		const messages: Record<string, unknown>[] = [];
		const panel = createFakePanel(messages);
		const provider = new ChatViewProvider(
			{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
			{
				sessionManager: {} as unknown as LocalSessionManager,
				registry: {} as ToolRegistry,
				eventBus: { onAll: () => () => { } } as unknown as EventBus,
			},
		);
		provider.setSettingsDeps({
			modelStore: undefined as never,
			getSyncSource: () => 'none',
			getSkillDirectories: () => [],
			setSyncSource: async (s) => s,
			setSkillDirectories: async (d) => [...d],
			getModelName: () => 'test',
			uploadSkillArchive: async () => ({ ok: false, reason: 'x' }),
			mcpStore: undefined,
		});
		const internals = provider as unknown as SettingsInternals;
		await internals._handleSettingsMessage(panel, {
			command: 'saveMcpServersJson',
			json: STDIO_JSON_WITH_ENV,
			mode: 'add',
		});

		const msg = lastMessage(messages, 'mcpSettingsError');
		assert.ok(msg, '未就绪应返回 mcpSettingsError');
		assert.strictEqual(msg?.operation, 'save');
	});

	it('setMcpServerEnabled 成功：回推 mcpOperationAccepted 并通知运行时', async () => {
		const { messages, panel, internals, mcpStore, configChangedCalls } = setup();
		await mcpStore.saveAddImport(STDIO_JSON_WITH_ENV);
		await internals._handleSettingsMessage(panel, {
			command: 'setMcpServerEnabled',
			serverId: 'codegraph',
			enabled: false,
		});

		const msg = lastMessage(messages, 'mcpOperationAccepted');
		assert.ok(msg, '应返回 mcpOperationAccepted');
		assert.strictEqual(msg?.serverId, 'codegraph');
		assert.strictEqual(msg?.operation, 'setEnabled');
		assert.strictEqual(configChangedCalls.length, 1, '应通知运行时应用启停');
	});

	it('setMcpServerEnabled 缺少 serverId：返回 mcpSettingsError', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'setMcpServerEnabled',
			enabled: false,
		});

		const msg = lastMessage(messages, 'mcpSettingsError');
		assert.ok(msg, '伪造消息应返回 mcpSettingsError');
		assert.strictEqual(msg?.operation, 'setEnabled');
		assert.ok(String(msg?.message).includes('serverId'), '应提示缺少 serverId');
	});

	it('setMcpServerEnabled 伪造 serverId（不存在）：返回 mcpSettingsError', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'setMcpServerEnabled',
			serverId: 'no-such-server',
			enabled: true,
		});

		const msg = lastMessage(messages, 'mcpSettingsError');
		assert.ok(msg, '不存在的 Server 应返回错误');
		assert.strictEqual(msg?.operation, 'setEnabled');
	});

	it('reconnectMcpServer 成功：回推 mcpOperationAccepted 并调用 onMcpReconnect', async () => {
		const { messages, panel, internals, mcpStore, reconnectCalls } = setup();
		await mcpStore.saveAddImport(STDIO_JSON_WITH_ENV);
		await internals._handleSettingsMessage(panel, {
			command: 'reconnectMcpServer',
			serverId: 'codegraph',
		});

		const msg = lastMessage(messages, 'mcpOperationAccepted');
		assert.ok(msg, '应返回 mcpOperationAccepted');
		assert.strictEqual(msg?.operation, 'reconnect');
		assert.deepStrictEqual(reconnectCalls, ['codegraph'], '应调用 onMcpReconnect');
	});

	it('reconnectMcpServer 缺少 serverId：返回 mcpSettingsError', async () => {
		const { messages, panel, internals, reconnectCalls } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'reconnectMcpServer',
		});

		const msg = lastMessage(messages, 'mcpSettingsError');
		assert.ok(msg, '缺 serverId 应返回错误');
		assert.strictEqual(msg?.operation, 'reconnect');
		assert.strictEqual(reconnectCalls.length, 0, '不得调用重连');
	});

	it('deleteMcpServer 成功：回推 mcpSettingsSaved（不含已删除 Server）并通知运行时', async () => {
		const { messages, panel, internals, mcpStore, configChangedCalls } = setup();
		await mcpStore.saveAddImport(STDIO_JSON_WITH_ENV);
		await internals._handleSettingsMessage(panel, {
			command: 'deleteMcpServer',
			serverId: 'codegraph',
		});

		const msg = lastMessage(messages, 'mcpSettingsSaved');
		assert.ok(msg, '删除成功应回推 mcpSettingsSaved');
		const servers = msg?.servers as McpServerView[];
		assert.ok(!servers.some((s) => s.id === 'codegraph'), '快照不应再含已删除 Server');
		assert.strictEqual(configChangedCalls.length, 1, '应通知运行时下线');
	});

	it('deleteMcpServer 缺少 serverId：返回 mcpSettingsError', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'deleteMcpServer',
		});

		const msg = lastMessage(messages, 'mcpSettingsError');
		assert.ok(msg, '缺 serverId 应返回错误');
		assert.strictEqual(msg?.operation, 'delete');
	});

	it('deleteMcpServer 成功后 Secrets 被清理且不回传', async () => {
		const { messages, panel, internals, mcpStore } = setup();
		await mcpStore.saveAddImport(STDIO_JSON_WITH_ENV);
		await internals._handleSettingsMessage(panel, {
			command: 'deleteMcpServer',
			serverId: 'codegraph',
		});

		const msg = lastMessage(messages, 'mcpSettingsSaved');
		assert.ok(!JSON.stringify(msg).includes('sk-secret-value'), '删除后明文不得回传');
		const doc = await mcpStore.getDocument();
		assert.strictEqual(doc.servers['codegraph'], undefined, 'Store 应已移除该 Server');
	});

	it('HTTP Server header 明文在保存与快照中均不回传', async () => {
		const { messages, panel, internals } = setup();
		await internals._handleSettingsMessage(panel, {
			command: 'saveMcpServersJson',
			json: HTTP_JSON_WITH_HEADER,
			mode: 'add',
		});

		const msg = lastMessage(messages, 'mcpSettingsSaved');
		assert.ok(!JSON.stringify(msg).includes('secret-bearer'), 'header 明文不得回传');
		const servers = msg?.servers as McpServerView[];
		const remote = servers.find((s) => s.id === 'remote-docs');
		assert.ok(remote?.config.type === 'streamable-http' && remote.config.headerNames.includes('Authorization'), '应只暴露 headerNames');
	});

	it('pushMcpSnapshot 设置面板未打开时安全跳过不抛错', async () => {
		const { mcpStore } = setup();
		const provider = new ChatViewProvider(
			{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
			{
				sessionManager: {} as unknown as LocalSessionManager,
				registry: {} as ToolRegistry,
				eventBus: { onAll: () => () => { } } as unknown as EventBus,
			},
		);
		const messages: Record<string, unknown>[] = [];
		// 未调用 openSettings，_settingsPanel 为 undefined
		provider.setSettingsDeps({
			modelStore: undefined as never,
			getSyncSource: () => 'none',
			getSkillDirectories: () => [],
			setSyncSource: async (s) => s,
			setSkillDirectories: async (d) => [...d],
			getModelName: () => 'test',
			uploadSkillArchive: async () => ({ ok: false, reason: 'x' }),
			mcpStore,
			getMcpSnapshot: async () => [],
		});
		const pusher = provider as unknown as { pushMcpSnapshot(): Promise<void> };
		await pusher.pushMcpSnapshot();
		assert.strictEqual(messages.length, 0, '面板未打开不应推送消息');
	});

	it('pushMcpSnapshot 装配面板与快照后推送 mcpSettings', async () => {
		const { messages, panel, mcpStore } = setup();
		const provider = new ChatViewProvider(
			{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
			{
				sessionManager: {} as unknown as LocalSessionManager,
				registry: {} as ToolRegistry,
				eventBus: { onAll: () => () => { } } as unknown as EventBus,
			},
		);
		await mcpStore.saveAddImport(STDIO_JSON_WITH_ENV);
		provider.setSettingsDeps({
			modelStore: undefined as never,
			getSyncSource: () => 'none',
			getSkillDirectories: () => [],
			setSyncSource: async (s) => s,
			setSkillDirectories: async (d) => [...d],
			getModelName: () => 'test',
			uploadSkillArchive: async () => ({ ok: false, reason: 'x' }),
			mcpStore,
			getMcpSnapshot: async () => {
				const entries = await mcpStore.getSettingsView();
				return entries.map((entry) => ({
					id: entry.id,
					configuredTransport: entry.config.type,
					enabled: entry.config.enabled,
					status: 'ready' as McpServerStatus,
					toolCount: 0,
					tools: [],
					config: entry.config,
				})) satisfies McpServerView[];
			},
		});
		// 注入面板引用（模拟设置面板已打开）
		(provider as unknown as { _settingsPanel: vscode.WebviewPanel })._settingsPanel = panel;
		const pusher = provider as unknown as { pushMcpSnapshot(): Promise<void> };
		await pusher.pushMcpSnapshot();

		const msg = lastMessage(messages, 'mcpSettings');
		assert.ok(msg, '应推送 mcpSettings');
		const servers = msg?.servers as McpServerView[];
		assert.ok(servers.some((s) => s.id === 'codegraph'), '快照应含已配置 Server');
	});
});
