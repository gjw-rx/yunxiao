import * as assert from 'assert';
import * as vscode from 'vscode';
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

describe('ChatViewProvider HTML rendering', () => {
	it('renders model info display in header', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		assert.match(html, /id="modelName"/);
		assert.match(html, /class="model-info"/);
	});

	it('在首个思考或回复片段到达前展示思考动画', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		assert.match(html, /\.message\.assistant\.thinking/);
		assert.match(html, /@keyframes thinking-dot/);
		assert.match(html, /function showThinkingIndicator\(\)/);
		assert.match(html, /function removeThinkingIndicator\(\)/);
		assert.match(html, /setStreaming\(true\);[\s\S]*?showThinkingIndicator\(\);/);
		assert.match(html, /case 'replyChunk':[\s\S]*?removeThinkingIndicator\(\);[\s\S]*?updateAssistantMsg/);
		assert.match(html, /case 'thought':[\s\S]*?removeThinkingIndicator\(\);[\s\S]*?showThought/);
		assert.match(html, /case 'replyEnd':[\s\S]*?removeThinkingIndicator\(\);/);
		assert.match(html, /case 'error':[\s\S]*?removeThinkingIndicator\(\);/);
	});

	it('reuses one thought step and merges incremental or cumulative stream text', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		assert.match(html, /let currentThoughtEl = null;/);
		assert.match(html, /function mergeStreamText\(current, incoming\)/);
		assert.match(html, /currentThoughtTxt = mergeStreamText\(currentThoughtTxt, text\);/);
		assert.match(html, /if \(!currentThoughtEl\) \{[\s\S]*?addStep\(step\);[\s\S]*?currentThoughtEl = step;/);
		assert.match(html, /const body = currentThoughtEl\.querySelector\('\.step-body'\);[\s\S]*?body\.textContent = currentThoughtTxt;/);

		const source = html.match(/function mergeStreamText\(current, incoming\) \{[\s\S]*?\n    \}/)?.[0];
		assert.ok(source);
		const merge = new Function(`${source}; return mergeStreamText;`)() as (
			current: string,
			incoming: string,
		) => string;
		assert.strictEqual(merge('', 'The '), 'The ');
		assert.strictEqual(merge('The ', 'user'), 'The user');
		assert.strictEqual(merge('The user', 'The user wants'), 'The user wants');
		assert.strictEqual(merge('The user wants', 'The user wants'), 'The user wants');
	});

	it('formats token usage as absolute totals without a fake context ratio', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		const numberSource = html.match(/function formatNumber\(n\) \{[\s\S]*?\n    \}/)?.[0];
		const source = html.match(/function formatTokenUsage\(usage\) \{[\s\S]*?\n    \}/)?.[0];
		assert.ok(numberSource);
		assert.ok(source);
		const format = new Function(`${numberSource}; ${source}; return formatTokenUsage;`)() as (
			usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; reasoning_tokens?: number; cache_read_tokens?: number },
		) => {
			text: string;
			title: string;
		};

		assert.deepStrictEqual(format({
			prompt_tokens: 15_700,
			completion_tokens: 2_600,
			total_tokens: 18_300,
		}), {
			text: '18,300',
			title: '本次 Token 消耗：18,300；输入 15,700，输出 2,600（缓存为输入侧明细，不计入总量）',
		});
		assert.deepStrictEqual(format({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		}), {
			text: '--',
			title: 'Token 用量不可用',
		});
	});

	it('大缓存命中不显示 100% 伪上下文占比：只展示本次 total 与输入侧明细', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		const numberSource = html.match(/function formatNumber\(n\) \{[\s\S]*?\n    \}/)?.[0];
		const source = html.match(/function formatTokenUsage\(usage\) \{[\s\S]*?\n    \}/)?.[0];
		assert.ok(numberSource);
		assert.ok(source);
		const format = new Function(`${numberSource}; ${source}; return formatTokenUsage;`)() as (
			usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; reasoning_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; no_cache_tokens?: number },
		) => {
			text: string;
			title: string;
		};

		// 用户日志场景：prompt=11583、output=105、total=11688、cacheRead=11392
		const formatted = format({
			prompt_tokens: 11583,
			completion_tokens: 105,
			total_tokens: 11688,
			reasoning_tokens: 0,
			cache_read_tokens: 11392,
		});
		assert.strictEqual(formatted.text, '11,688', '只显示本次 total，不显示 total/input 比值');
		assert.ok(!formatted.text.includes('%'), '不应出现百分比');
		assert.ok(formatted.title.includes('缓存读 11,392'), '缓存读取作为输入侧明细展示');
		assert.ok(!formatted.title.includes('100%'), '不应出现约 100% 占比');
	});

	it('历史恢复聚合：仅以 assistant tokenUsage 快照为权威，user inputTokens 不双重累计', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		const source = html.match(/function aggregateSessionTokens\(messages\) \{[\s\S]*?\n    \}/)?.[0];
		assert.ok(source);
		const aggregate = new Function(`${source}; return aggregateSessionTokens;`)() as (
			messages: Array<Record<string, unknown>>,
		) => {
			total_tokens: number;
			breakdown: Record<string, number>;
			cache_read_tokens?: number;
			cache_write_tokens?: number;
			no_cache_tokens?: number;
		} | null;

		// 与实时 session_token_usage payload 口径一致：user 消息 inputTokens 不参与累计
		const messages = [
			{ role: 'user', seq: 1, content: 'hello', inputTokens: 50 },
			{ role: 'assistant', seq: 2, content: 'hi', tokenUsage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning: 20, tool_calls: 0, model_output: 30, user_input: 10, context: 90 } },
			{ role: 'user', seq: 3, content: 'again', inputTokens: 40 },
			{ role: 'assistant', seq: 4, content: 'ok', tokenUsage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260, reasoning: 0, tool_calls: 0, model_output: 60, user_input: 20, context: 180, cache_read_tokens: 90, no_cache_tokens: 110 } },
		];
		const agg = aggregate(messages);
		assert.ok(agg);
		assert.strictEqual(agg.total_tokens, 410, 'user inputTokens 不被重复累加');
		assert.strictEqual(agg.breakdown.user_input, 30, 'user_input 仅来自 assistant 快照');
		assert.strictEqual(agg.breakdown.context, 270, '上下文仅来自快照');
		assert.strictEqual(agg.cache_read_tokens, 90);
		assert.strictEqual(agg.no_cache_tokens, 110);
	});

	it('历史恢复聚合：无快照旧 assistant 消息按内容估算补齐（仅展示），不写回', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		const source = html.match(/function aggregateSessionTokens\(messages\) \{[\s\S]*?\n    \}/)?.[0];
		assert.ok(source);
		const aggregate = new Function(`${source}; return aggregateSessionTokens;`)() as (
			messages: Array<Record<string, unknown>>,
		) => {
			total_tokens: number;
			breakdown: Record<string, number>;
		} | null;

		const oldText = 'old reply without usage';
		const agg = aggregate([
			{ role: 'user', seq: 1, content: 'hello' },
			{ role: 'assistant', seq: 2, content: oldText },
			{ role: 'assistant', seq: 3, content: 'ok', tokenUsage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning: 20, tool_calls: 0, model_output: 30, user_input: 10, context: 90 } },
		]);
		assert.ok(agg);
		assert.strictEqual(agg.total_tokens, 150 + Math.ceil(oldText.length / 4), '无快照旧消息按内容估算补齐');
		assert.strictEqual(agg.breakdown.model_output, 30 + Math.ceil(oldText.length / 4), '估算归入模型回复展示');
	});

	it('preserves tool arguments while the same entry receives its result', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		assert.match(html, /entry\.args = args !== undefined && args !== null \? args : entry\.args;/);
		assert.match(html, /entry\.output = output !== undefined && output !== null \? output : entry\.output;/);
		assert.match(html, /if \(entry\.args !== undefined && entry\.args !== null\)/);
		assert.match(html, /else if \(entry\.output !== undefined && entry\.output !== null\)/);
	});

	it('wraps the complete thought text to the webview width without clamping', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		const thoughtStyle = html.match(/\.step\.thought \.step-body \{([\s\S]*?)\}/)?.[1];
		assert.ok(thoughtStyle);
		assert.match(thoughtStyle, /width: 100%;/);
		assert.match(thoughtStyle, /min-width: 0;/);
		assert.match(thoughtStyle, /white-space: pre-wrap;/);
		assert.match(thoughtStyle, /overflow-wrap: anywhere;/);
		assert.match(thoughtStyle, /word-break: break-word;/);

		const showThought = html.match(/function showThought\(text\) \{([\s\S]*?)\n    \}\n\n    function showPlan/)?.[1];
		assert.ok(showThought);
		assert.doesNotMatch(showThought, /collapsed-text|scrollHeight|toggleBound/);
		assert.doesNotMatch(html, /\.step\.thought\.collapsed-text/);
	});

	it('renders a slash command picker infrastructure', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		assert.match(html, /id="slashCommandPicker"/);
		assert.match(html, /function handleSlashTrigger\(\)/);
		assert.match(html, /function renderSlashCommands\(\)/);
	});

	it('会话删除改由 host 显式通知，不再按列表缺当前会话推断删除', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		// 新分支存在：host 显式通知当前会话被删除
		assert.match(html, /case 'currentSessionDeleted':/);
		// 旧误判逻辑已移除：renderHistoryDropdown 不再根据列表缺当前会话重置状态
		assert.doesNotMatch(html, /if \(currentSessionId && !sessions\.some/);
	});

	it('renders file references as removable chips while preserving paths on send', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		assert.match(html, /id="fileReferenceList"/);
		assert.match(html, /class="file-reference-chip"/);
		assert.match(html, /class="file-reference-remove"/);
		assert.match(html, /aria-label="取消引用 /);
		assert.match(html, /selectedFiles\.some\(\(selected\) => selected\.path === file\.path\)/);
		// 文件引用作为独立 files 字段传递，不再用 @ 前缀拼接进文本
		assert.match(html, /selectedFiles\.slice\(\)/);
		assert.match(html, /command: 'sendMessage'[\s\S]*?files/);
		assert.doesNotMatch(html, /'@' \+ file\.path/);
		assert.match(html, /selectedFiles = \[\];[\s\S]*?renderFileReferences\(\);/);
		assert.doesNotMatch(html, /const insert = '@' \+ file\.path \+ ' ';/);
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
});
