import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../chatPanel';
import type { LocalSessionManager } from '../core/localSessionManager';
import type { ToolRegistry } from '../core/toolRegistry';
import type { EventBus } from '../core/eventBus';

interface PanelInternals {
	_view?: vscode.WebviewView;
	_currentSessionId?: string;
	_getHtml(webview: vscode.Webview): string;
	_handleMessage(msg: { command: string; [key: string]: unknown }): Promise<void>;
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
			eventBus: {} as EventBus,
		}
	);
	const internals = provider as unknown as PanelInternals;
	internals._view = {
		webview: { postMessage: (message: Record<string, unknown>) => messages.push(message) },
	} as unknown as vscode.WebviewView;
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

	it('formats token usage with context ratio and prompt/completion details', () => {
		const { internals } = setup();
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		const numberSource = html.match(/function formatNumber\(n\) \{[\s\S]*?\n    \}/)?.[0];
		const source = html.match(/function formatTokenUsage\(usage, inputLength\) \{[\s\S]*?\n    \}/)?.[0];
		assert.ok(numberSource);
		assert.ok(source);
		const format = new Function(`${numberSource}; ${source}; return formatTokenUsage;`)() as (
			usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
			inputLength: number,
		) => {
			text: string;
			title: string;
			percent: number | null;
		};

		assert.deepStrictEqual(format({
			prompt_tokens: 15_700,
			completion_tokens: 2_600,
			total_tokens: 18_300,
		}, 128_000), {
			text: '18,300 / 128,000 (14.3%)',
			title: '本轮 Token 消耗：18,300 / 128,000 (14.3%)；输入 15,700，输出 2,600',
			percent: 14.3,
		});
		assert.deepStrictEqual(format({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		}, 128_000), {
			text: '--',
			title: 'Token 用量不可用',
			percent: null,
		});
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
});
