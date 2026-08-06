import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../chatPanel';
import type { AIClient } from '../aiClient';
import type { ToolRegistry } from '../core/toolRegistry';
import type { SessionManager } from '../core/sessionManager';
import type { EventBus } from '../core/eventBus';

interface PanelInternals {
	_view?: vscode.WebviewView;
	_currentSessionId?: string;
	_getHtml(webview: vscode.Webview): string;
	_handleMessage(msg: { command: string; [key: string]: unknown }): Promise<void>;
}

interface SessionResult {
	session_id: string;
	agent_id: string;
}

function setup(createSession: () => Promise<SessionResult>) {
	const calls: unknown[][] = [];
	const resets: string[] = [];
	const messages: Record<string, unknown>[] = [];
	const provider = new ChatViewProvider(
		{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
		{
			client: {
				createSession: (...args: unknown[]) => {
					calls.push(args);
					return createSession();
				},
			} as unknown as AIClient,
			registry: { localSchemas: () => [] } as unknown as ToolRegistry,
			sessionManager: { reset: (sessionId: string) => resets.push(sessionId) } as unknown as SessionManager,
			eventBus: {} as EventBus,
		}
	);
	const internals = provider as unknown as PanelInternals;
	internals._view = {
		webview: { postMessage: (message: Record<string, unknown>) => messages.push(message) },
	} as unknown as vscode.WebviewView;
	internals._currentSessionId = 'old-session';
	return { calls, resets, messages, internals };
}

describe('ChatViewProvider session creation', () => {
	it('passes the current workspace root and resets the old session after success', async () => {
		const { calls, resets, messages, internals } = setup(async () => ({
			session_id: 'new-session',
			agent_id: 'a2',
		}));

		await internals._handleMessage({ command: 'createSession', agentId: 'a2' });

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0][1], []);
		assert.strictEqual(calls[0][2], vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
		assert.deepStrictEqual(resets, ['old-session']);
		assert.strictEqual(internals._currentSessionId, 'new-session');
		assert.deepStrictEqual(messages, [{ command: 'sessionCreated', sessionId: 'new-session' }]);
	});

	it('preserves the old session when creating its replacement fails', async () => {
		const { resets, messages, internals } = setup(async () => {
			throw new Error('unavailable');
		});

		await internals._handleMessage({ command: 'createSession', agentId: 'a2' });

		assert.deepStrictEqual(resets, []);
		assert.strictEqual(internals._currentSessionId, 'old-session');
		assert.strictEqual(messages[0].command, 'error');
	});

	it('ignores a stale session response after a later request succeeds', async () => {
		let resolveFirst!: (result: SessionResult) => void;
		let resolveSecond!: (result: SessionResult) => void;
		const first = new Promise<SessionResult>((resolve) => { resolveFirst = resolve; });
		const second = new Promise<SessionResult>((resolve) => { resolveSecond = resolve; });
		const responses = [first, second];
		const { resets, messages, internals } = setup(() => responses.shift()!);

		const firstRequest = internals._handleMessage({ command: 'createSession', agentId: 'a2' });
		const secondRequest = internals._handleMessage({ command: 'createSession', agentId: 'a3' });
		resolveSecond({ session_id: 'newest-session', agent_id: 'a3' });
		await secondRequest;
		resolveFirst({ session_id: 'stale-session', agent_id: 'a2' });
		await firstRequest;

		assert.deepStrictEqual(resets, ['old-session']);
		assert.strictEqual(internals._currentSessionId, 'newest-session');
		assert.deepStrictEqual(messages, [{ command: 'sessionCreated', sessionId: 'newest-session' }]);
	});

	it('renders Agent switching as a new-session trigger only when the selection changes', () => {
		const { internals } = setup(async () => ({ session_id: 'unused', agent_id: 'unused' }));
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		assert.match(html, /const changed = selectedAgentId && selectedAgentId !== agentId;/);
		assert.match(html, /if \(changed\) startNewSession\(\);/);
	});

	it('reuses one thought step and merges incremental or cumulative stream text', () => {
		const { internals } = setup(async () => ({ session_id: 'unused', agent_id: 'unused' }));
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

	it('preserves tool arguments while the same entry receives its result', () => {
		const { internals } = setup(async () => ({ session_id: 'unused', agent_id: 'unused' }));
		const html = internals._getHtml({
			asWebviewUri: (uri: vscode.Uri) => uri,
			cspSource: 'vscode-webview:',
		} as unknown as vscode.Webview);

		assert.match(html, /entry\.args = args !== undefined && args !== null \? args : entry\.args;/);
		assert.match(html, /entry\.output = output !== undefined && output !== null \? output : entry\.output;/);
		assert.match(html, /if \(entry\.args !== undefined && entry\.args !== null\)/);
		assert.match(html, /else if \(entry\.output !== undefined && entry\.output !== null\)/);
	});
});
