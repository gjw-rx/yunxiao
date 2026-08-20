/**
 * ChatPanel Plan 模式消息协议测试。
 * 覆盖：Plan 状态加载回推、当前会话事件过滤、模式动作校验与历史刷新状态回推。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../chatPanel';
import { EventBus } from '../core/eventBus';
import type { LocalSessionManager } from '../core/localSessionManager';
import { SessionPlanModeStore } from '../core/planModeStore';
import type { ToolRegistry } from '../core/toolRegistry';
import { SessionFileStore } from '../memory/sessionFileStore';
import { SessionTodoStore } from '../memory/sessionTodoStore';

interface PanelInternals {
	_chatWebview?: vscode.Webview;
	_currentSessionId?: string;
	setRuntimeStatus(status: 'initializing' | 'ready' | 'failed', message?: string): void;
	resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken
	): void;
	_handleMessage(msg: { command: string; [key: string]: unknown }): Promise<void>;
}

/** 测试环境装配。 */
function setup(): {
	messages: Record<string, unknown>[];
	internals: PanelInternals;
	eventBus: EventBus;
	planMode: SessionPlanModeStore;
	planCalls: string[];
	cleanup: () => void;
} {
	const messages: Record<string, unknown>[] = [];
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunforce-chat-plan-'));
	const fileStore = new SessionFileStore('/Users/test/Plan Chat', baseDir);
	const eventBus = new EventBus();
	const planMode = new SessionPlanModeStore(fileStore, eventBus);
	const todoStore = new SessionTodoStore(fileStore);
	const planCalls: string[] = [];

	const sessionManager = {
		createSession: () => 's1',
		reset: () => {},
		sendMessage: () => {},
		cancel: () => {},
		loadHistory: () => [],
		enterPlanMode: (id: string) => {
			planCalls.push(`enter:${id}`);
			planMode.transition(id, 'planning');
		},
		continuePlanning: (id: string) => {
			planCalls.push(`continue:${id}`);
			planMode.transition(id, 'planning');
		},
		exitPlanMode: (id: string) => {
			planCalls.push(`exit:${id}`);
			planMode.transition(id, 'normal');
		},
		confirmExecution: (id: string) => {
			planCalls.push(`confirm:${id}`);
			planMode.transition(id, 'executing');
		},
	} as unknown as LocalSessionManager;

	const provider = new ChatViewProvider(
		{ extensionPath: '', subscriptions: [] } as unknown as vscode.ExtensionContext,
		{
			sessionManager,
			registry: {} as ToolRegistry,
			eventBus,
			todoStore,
			planModeStore: planMode,
		},
	);
	const internals = provider as unknown as PanelInternals & { _chatWebview?: vscode.Webview };
	// 通过 resolveWebviewView 建立事件订阅与 webview 引用，使 plan_mode_change 能转发
	const view = {
		webview: {
			html: '',
			cspSource: 'vscode-webview:',
			asWebviewUri: (uri: vscode.Uri) => uri,
			postMessage: (message: Record<string, unknown>) => messages.push(message),
			onDidReceiveMessage: () => ({ dispose: () => {} }),
		},
		onDidDispose: () => ({ dispose: () => {} }),
		onDidChangeVisibility: () => ({ dispose: () => {} }),
	} as unknown as vscode.WebviewView;
	internals.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
	internals.setRuntimeStatus('ready');
	internals._currentSessionId = 's1';
	return {
		messages,
		internals,
		eventBus,
		planMode,
		planCalls,
		cleanup: () => fs.rmSync(baseDir, { recursive: true, force: true }),
	};
}

/** 提取最近一条 planModeState 消息。 */
function lastPlanMode(messages: Record<string, unknown>[]): { sessionId: string; state: unknown } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].command === 'planModeState') {
			return { sessionId: messages[index].sessionId as string, state: messages[index].state };
		}
	}
	return undefined;
}

describe('ChatPanel Plan 模式协议', () => {
	it('loadHistory 回推对应会话的 Plan 状态（normal 会话也回推）', async () => {
		const { messages, internals, cleanup } = setup();
		try {
			await internals._handleMessage({ command: 'loadHistory', sessionId: 's1' });
			const plan = lastPlanMode(messages);
			assert.ok(plan, 'loadHistory 应回推 planModeState');
			assert.deepStrictEqual(plan.state, { stage: 'normal', draftCreated: false });
		} finally {
			cleanup();
		}
	});

	it('planning 会话加载历史时回推 planning 状态', async () => {
		const { messages, internals, planMode, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			await internals._handleMessage({ command: 'loadHistory', sessionId: 's1' });
			const plan = lastPlanMode(messages);
			assert.deepStrictEqual(plan?.state, { stage: 'planning', draftCreated: false });
		} finally {
			cleanup();
		}
	});

	it('plan_mode_change 事件仅转发当前会话，非当前会话被忽略', async () => {
		const { messages, internals, eventBus, planMode, cleanup } = setup();
		try {
			// 当前会话状态变化（transition 自身产生一条转发）
			planMode.transition('s1', 'planning');
			messages.length = 0;
			// 当前会话事件：planning → review，应转发
			eventBus.emit({
				type: 'plan_mode_change',
				sessionId: 's1',
				payload: { from: 'planning', to: 'review', draftCreated: true },
			});
			// 非当前会话事件：s2 的规划状态，不应转发
			eventBus.emit({
				type: 'plan_mode_change',
				sessionId: 's2',
				payload: { from: 'normal', to: 'planning', draftCreated: false },
			});
			const plans = messages.filter((m) => m.command === 'planModeState');
			assert.strictEqual(plans.length, 1);
			assert.deepStrictEqual(plans[0].state, { stage: 'review', draftCreated: true });
		} finally {
			cleanup();
		}
	});

	it('enterPlanMode 消息调用会话管理器并回推状态', async () => {
		const { messages, internals, planCalls, cleanup } = setup();
		try {
			await internals._handleMessage({ command: 'enterPlanMode', sessionId: 's1' });
			assert.deepStrictEqual(planCalls, ['enter:s1']);
			const plan = lastPlanMode(messages);
			assert.strictEqual((plan?.state as { stage: string }).stage, 'planning');
		} finally {
			cleanup();
		}
	});

	it('confirmExecution 消息调用会话管理器并回推 executing', async () => {
		const { messages, internals, planMode, planCalls, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			planMode.transition('s1', 'review');
			await internals._handleMessage({ command: 'confirmExecution', sessionId: 's1' });
			assert.deepStrictEqual(planCalls, ['confirm:s1']);
			const plan = lastPlanMode(messages);
			assert.strictEqual((plan?.state as { stage: string }).stage, 'executing');
		} finally {
			cleanup();
		}
	});

	it('continuePlanning / exitPlanMode 消息到达会话管理器', async () => {
		const { internals, planMode, planCalls, cleanup } = setup();
		try {
			planMode.transition('s1', 'planning');
			planMode.transition('s1', 'review');
			await internals._handleMessage({ command: 'continuePlanning', sessionId: 's1' });
			await internals._handleMessage({ command: 'exitPlanMode', sessionId: 's1' });
			assert.deepStrictEqual(planCalls, ['continue:s1', 'exit:s1']);
		} finally {
			cleanup();
		}
	});

	it('过期会话的 Plan 操作不会调用会话管理器', async () => {
		const { internals, planCalls, cleanup } = setup();
		try {
			await internals._handleMessage({ command: 'enterPlanMode', sessionId: 's2' });
			assert.deepStrictEqual(planCalls, []);
		} finally {
			cleanup();
		}
	});
});
