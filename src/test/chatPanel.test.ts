import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from '../chatPanel';
import type { LocalSessionManager } from '../core/localSessionManager';
import type { ToolRegistry } from '../core/toolRegistry';
import type { EventBus } from '../core/eventBus';

interface PanelInternals {
	_chatView?: vscode.WebviewView;
	_chatWebview?: vscode.Webview;
	_settingsPanel?: vscode.WebviewPanel;
	_currentSessionId?: string;
	show(): void;
	resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken
	): void;
	_getHtml(webview: vscode.Webview, page?: 'chat' | 'settings'): string;
	_handleMessage(msg: { command: string; [key: string]: unknown }): Promise<void>;
	setRuntimeStatus(status: 'initializing' | 'ready' | 'failed', message?: string): void;
}

/** 构造一个可用的假 WebviewPanel（记录 onDidDispose 回调，供测试触发）。 */
function createFakePanel(disposeHandlers: (() => void)[]): vscode.WebviewPanel {
	return {
		iconPath: undefined,
		webview: {
			html: '',
			cspSource: 'vscode-webview:',
			asWebviewUri: (uri: vscode.Uri) => uri,
			postMessage: () => {},
			onDidReceiveMessage: () => ({ dispose: () => {} }),
		},
		onDidDispose: (handler: () => void) => {
			disposeHandlers.push(handler);
			return { dispose: () => {} };
		},
		reveal: () => {},
		dispose: () => {},
	} as unknown as vscode.WebviewPanel;
}

function setup() {
	const messages: Record<string, unknown>[] = [];
	const provider = new ChatViewProvider(
		{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
		{
			sessionManager: {
				createSession: () => 'new-session',
				reset: () => {},
				sendMessage: () => {},
				cancel: () => {},
				loadHistory: () => [],
			} as unknown as LocalSessionManager,
			registry: {} as ToolRegistry,
			eventBus: { onAll: () => () => {} } as unknown as EventBus,
		}
	);
	const internals = provider as unknown as PanelInternals;
	internals._chatWebview = {
		postMessage: (message: Record<string, unknown>) => messages.push(message),
	} as unknown as vscode.Webview;
	internals.setRuntimeStatus('ready');
	internals._currentSessionId = 'old-session';
	return { messages, internals };
}

/** 构造一个能记录 asWebviewUri 调用、cspSource 固定的假 Webview。 */
function createFakeWebview(calledUris: string[] = []): vscode.Webview {
	return {
		asWebviewUri: (uri: vscode.Uri) => {
			calledUris.push(uri.fsPath);
			return uri;
		},
		cspSource: 'vscode-webview:',
	} as unknown as vscode.Webview;
}

describe('ChatViewProvider HTML shell 与资源加载', () => {
	it('运行时未就绪时回传状态并拒绝创建会话', async () => {
		const { messages, internals } = setup();
		internals.setRuntimeStatus('initializing');

		await internals._handleMessage({ command: 'webviewReady' });
		await internals._handleMessage({ command: 'createSession' });
		await internals._handleMessage({ command: 'requestSlashCommands' });

		assert.ok(messages.some((message) => message.command === 'runtimeState' && message.status === 'initializing'));
		assert.ok(!messages.some((message) => message.command === 'sessionCreated'));
		assert.ok(!messages.some((message) => message.command === 'slashCommands'));

		internals.setRuntimeStatus('failed', 'Skill 加载失败');
		await internals._handleMessage({ command: 'webviewReady' });
		assert.ok(messages.some((message) => message.command === 'runtimeState' && message.status === 'failed'));

		internals.setRuntimeStatus('ready');
		await internals._handleMessage({ command: 'createSession' });
		assert.ok(messages.some((message) => message.command === 'sessionCreated'));
	});

	it('扩展将聊天容器直接贡献到次级侧边栏', () => {
		const manifestPath = path.join(__dirname, '..', '..', 'package.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
			engines: { vscode: string };
			contributes: { viewsContainers: { secondarySidebar?: { id: string }[]; activitybar?: unknown[] } };
		};

		assert.strictEqual(manifest.engines.vscode, '^1.106.0');
		assert.deepStrictEqual(manifest.contributes.viewsContainers.secondarySidebar, [
			{ id: 'yunxiaoAgentContainer', title: '云效 Agent', icon: 'media/icon-view.svg' },
		]);
		assert.strictEqual(manifest.contributes.viewsContainers.activitybar, undefined);
	});

	it('_getHtml 输出最小 shell：根挂载节点 + 外部样式/脚本链接', () => {
		const { internals } = setup();
		const html = internals._getHtml(createFakeWebview());

		assert.match(html, /<div id="root"><\/div>/);
		assert.match(html, /<link rel="stylesheet" href="[^"]+index\.css">/);
		assert.match(html, /<script type="module" src="[^"]+index\.js"><\/script>/);
		// 不再内联任何 UI 代码（CSS/HTML/JS 均外置）
		assert.doesNotMatch(html, /id="messages"|id="inputArea"|id="sessionNameInput"/);
		assert.doesNotMatch(html, /function showToolState\(\)|window\.addEventListener\('message'/);
		assert.doesNotMatch(html, /<style>[\s\S]*<\/style>/);
		// 页面不得包含无 src 的内联脚本（仅允许外部模块脚本）
		assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
	});

	it('资源 URI 由 asWebviewUri 生成且指向 dist/webview-ui 固定产物', () => {
		const { internals } = setup();
		const calledUris: string[] = [];
		internals._getHtml(createFakeWebview(calledUris));

		const jsSuffix = path.join('dist', 'webview-ui', 'index.js');
		const cssSuffix = path.join('dist', 'webview-ui', 'index.css');
		assert.ok(
			calledUris.some((p) => p.endsWith(jsSuffix)),
			`应通过 asWebviewUri 生成 index.js 资源（实际: ${calledUris.join(' | ')}）`
		);
		assert.ok(
			calledUris.some((p) => p.endsWith(cssSuffix)),
			`应通过 asWebviewUri 生成 index.css 资源（实际: ${calledUris.join(' | ')}）`
		);
	});

	it('CSP 以 default-src none 为基础、只允许 cspSource，且不含 unsafe-inline', () => {
		const { internals } = setup();
		const html = internals._getHtml(createFakeWebview());
		const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1];
		assert.ok(csp, 'HTML 必须声明 CSP');
		assert.ok(csp.startsWith("default-src 'none'"), 'CSP 必须以 default-src none 为基础');
		assert.ok(!csp.includes('unsafe-inline'), 'CSP 不得允许 unsafe-inline');
		assert.ok(csp.includes('vscode-webview:'), 'CSP 应允许 cspSource 本地资源');
		// 页面不得依赖内联脚本或 nonce 脚本执行
		assert.doesNotMatch(html, /<script[^>]*nonce=/);
	});

	it('侧栏聊天视图配置 localResourceRoots 并加载正式聊天页面', () => {
		const disposeHandlers: (() => void)[] = [];
		const webview = createFakeWebview() as vscode.Webview & { options?: vscode.WebviewOptions; html: string; postMessage: () => void; onDidReceiveMessage: () => vscode.Disposable };
		webview.html = '';
		webview.postMessage = async () => true;
		webview.onDidReceiveMessage = () => ({ dispose: () => {} });
		const view = {
			webview,
			onDidDispose: (handler: () => void) => {
				disposeHandlers.push(handler);
				return { dispose: () => {} };
			},
		} as unknown as vscode.WebviewView;

		const { internals } = setup();
		internals.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

		assert.strictEqual(internals._chatView, view);
		assert.strictEqual(internals._chatWebview, webview);
		assert.match(webview.html, /<body data-view="chat">/);
		assert.ok(webview.options?.localResourceRoots?.some((root) => root.fsPath.endsWith('dist')));
		disposeHandlers.forEach((handler) => handler());
		assert.strictEqual(internals._chatWebview, undefined);
	});
});

describe('ChatViewProvider 侧栏视图', () => {
	it('show() 只聚焦扩展视图容器，不创建编辑区 WebviewPanel', async () => {
		const orig = vscode.commands.executeCommand;
		const origCreate = vscode.window.createWebviewPanel;
		const commands: string[] = [];
		let createdCount = 0;
		vscode.commands.executeCommand = (async (command: string) => {
			commands.push(command);
		}) as unknown as typeof vscode.commands.executeCommand;
		vscode.window.createWebviewPanel = (() => {
			createdCount++;
			return createFakePanel([]);
		}) as unknown as typeof vscode.window.createWebviewPanel;
		try {
			const { internals } = setup();
			internals.show();
			assert.deepStrictEqual(commands, ['workbench.view.extension.yunxiaoAgentContainer']);
			assert.strictEqual(createdCount, 0);
		} finally {
			vscode.commands.executeCommand = orig;
			vscode.window.createWebviewPanel = origCreate;
		}
	});

	it('侧栏视图销毁时取消事件订阅，并拒绝未决审批', () => {
		const disposeHandlers: (() => void)[] = [];
		let unsubCalled = false;
		const decisions: string[] = [];
		const provider = new ChatViewProvider(
			{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
			{
				sessionManager: { createSession: () => 'new-session' } as unknown as LocalSessionManager,
				registry: {} as ToolRegistry,
				eventBus: {
					onAll: () => () => {
						unsubCalled = true;
					},
				} as unknown as EventBus,
			}
		);
		const internals = provider as unknown as PanelInternals & {
			_pendingApprovals: Map<string, (decision: string) => void>;
		};
		internals._pendingApprovals.set('call-1', (d) => decisions.push(d));
		const webview = createFakeWebview() as vscode.Webview & { html: string; postMessage: () => void; onDidReceiveMessage: () => vscode.Disposable };
		webview.html = '';
		webview.postMessage = async () => true;
		webview.onDidReceiveMessage = () => ({ dispose: () => {} });
		const view = {
			webview,
			onDidDispose: (handler: () => void) => {
				disposeHandlers.push(handler);
				return { dispose: () => {} };
			},
		} as unknown as vscode.WebviewView;

		internals.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
		disposeHandlers.forEach((handler) => handler());
		assert.strictEqual(internals._chatView, undefined, '销毁后应清空视图引用');
		assert.strictEqual(unsubCalled, true, '销毁后应取消事件订阅');
		assert.deepStrictEqual(decisions, ['deny'], '未决审批应回退 deny');
	});

	it('deleteSession 删除当前会话时回推 currentSessionDeleted（前端不再靠列表推断删除）', async () => {
		const messages: Record<string, unknown>[] = [];
		const provider = new ChatViewProvider(
			{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
			{
				sessionManager: {
					listSessions: () => [
						{
							sessionId: 'old-session',
							title: '旧会话',
							updatedAt: '',
							messageCount: 1,
							customTitle: false,
						},
					],
					deleteSession: () => {},
				} as unknown as LocalSessionManager,
				registry: {} as ToolRegistry,
				eventBus: { onAll: () => () => {} } as unknown as EventBus,
			}
		);
		const internals = provider as unknown as PanelInternals;
		internals._chatWebview = {
			postMessage: (message: Record<string, unknown>) => messages.push(message),
		} as unknown as vscode.Webview;
		internals._currentSessionId = 'old-session';

		const origShow = vscode.window.showWarningMessage;
		vscode.window.showWarningMessage = (async () => '删除') as unknown as typeof vscode.window.showWarningMessage;
		try {
			await internals._handleMessage({ command: 'deleteSession', sessionId: 'old-session' });
		} finally {
			vscode.window.showWarningMessage = origShow;
		}

		const deleted = messages.find((m) => m.command === 'currentSessionDeleted');
		assert.ok(deleted, '删除当前会话应回推 currentSessionDeleted');
		assert.strictEqual(internals._currentSessionId, undefined, 'host 当前会话指针应清空');
	});

	it('openSettings 在编辑器打开独立设置标签，重复打开时复用已有标签', async () => {
		const orig = vscode.window.createWebviewPanel;
		const created: vscode.WebviewPanel[] = [];
		let revealCount = 0;
		vscode.window.createWebviewPanel = ((_viewType: string, _title: string) => {
			const panel = createFakePanel([]);
			panel.reveal = () => { revealCount++; };
			created.push(panel);
			return panel;
		}) as unknown as typeof vscode.window.createWebviewPanel;
		try {
			const { internals } = setup();
			await internals._handleMessage({ command: 'openSettings' });
			await internals._handleMessage({ command: 'openSettings' });

			assert.strictEqual(created.length, 1, '设置页应只创建一个独立编辑器标签');
			assert.strictEqual(internals._settingsPanel, created[0], '设置标签应由 Provider 持有');
			assert.match(created[0].webview.html, /<body data-view="settings">/);
			assert.strictEqual(revealCount, 1, '再次点击设置应聚焦已有标签');
		} finally {
			vscode.window.createWebviewPanel = orig;
		}
	});
});
