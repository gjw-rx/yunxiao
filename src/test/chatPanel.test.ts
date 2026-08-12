import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from '../chatPanel';
import type { LocalSessionManager } from '../core/localSessionManager';
import type { ToolRegistry } from '../core/toolRegistry';
import type { EventBus } from '../core/eventBus';

interface PanelInternals {
	_panel?: vscode.WebviewPanel;
	_currentSessionId?: string;
	show(): void;
	_getHtml(webview: vscode.Webview): string;
	_handleMessage(msg: { command: string; [key: string]: unknown }): Promise<void>;
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
	internals._panel = {
		webview: { postMessage: (message: Record<string, unknown>) => messages.push(message) },
	} as unknown as vscode.WebviewPanel;
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

	it('localResourceRoots 覆盖 dist 产物目录', () => {
		const orig = vscode.window.createWebviewPanel;
		let capturedRoots: readonly vscode.Uri[] | undefined;
		vscode.window.createWebviewPanel = ((_viewType: string, _title: string, _column: vscode.ViewColumn, options: vscode.WebviewPanelOptions & vscode.WebviewOptions) => {
			capturedRoots = options.localResourceRoots;
			return createFakePanel([]);
		}) as unknown as typeof vscode.window.createWebviewPanel;
		try {
			const { internals } = setup();
			internals._panel = undefined;
			internals.show();
			assert.ok(capturedRoots, 'createWebviewPanel 应传入 localResourceRoots');
			assert.ok(
				capturedRoots!.some((r) => r.fsPath.endsWith('dist')),
				'localResourceRoots 应覆盖 dist 目录（含 dist/webview-ui 产物）'
			);
		} finally {
			vscode.window.createWebviewPanel = orig;
		}
	});
});

describe('ChatViewProvider 编辑区面板（show 单例与关闭清理）', () => {
	it('show() 打开面板为单例：已打开时复用不重建', () => {
		const orig = vscode.window.createWebviewPanel;
		let createdCount = 0;
		vscode.window.createWebviewPanel = (() => {
			createdCount++;
			return createFakePanel([]);
		}) as unknown as typeof vscode.window.createWebviewPanel;
		try {
			const { internals } = setup();
			internals._panel = undefined; // 清除 setup 预设的假面板，验证 show() 的创建逻辑
			internals.show();
			const first = internals._panel;
			assert.ok(first);
			internals.show();
			assert.strictEqual(internals._panel, first, '再次 show 应复用同一面板');
			assert.strictEqual(createdCount, 1, '面板应只创建一次');
		} finally {
			vscode.window.createWebviewPanel = orig;
		}
	});

	it('面板关闭：清空 _panel、取消事件订阅、未决审批回退 deny', () => {
		const orig = vscode.window.createWebviewPanel;
		const disposeHandlers: (() => void)[] = [];
		vscode.window.createWebviewPanel = (() =>
			createFakePanel(disposeHandlers)) as unknown as typeof vscode.window.createWebviewPanel;
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
		try {
			internals.show();
			assert.ok(internals._panel);
			disposeHandlers.forEach((h) => h());
			assert.strictEqual(internals._panel, undefined, '关闭后应清空面板引用');
			assert.strictEqual(unsubCalled, true, '关闭后应取消事件订阅');
			assert.deepStrictEqual(decisions, ['deny'], '未决审批应回退 deny');
		} finally {
			vscode.window.createWebviewPanel = orig;
		}
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
		internals._panel = {
			webview: { postMessage: (message: Record<string, unknown>) => messages.push(message) },
		} as unknown as vscode.WebviewPanel;
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
});
