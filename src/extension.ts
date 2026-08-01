import * as vscode from 'vscode';
import { ChatViewProvider } from './chatPanel';
import { AIClient } from './aiClient';
import { ToolRegistry } from './core/toolRegistry';
import { ToolRouter } from './core/toolRouter';
import { EventBus } from './core/eventBus';
import { SessionManager } from './core/sessionManager';
import { ReadFileTool, DEFAULT_MAX_FILE_SIZE } from './tools/fs/readFile';
import { getWorkspaceRoots } from './tools/fs/pathGuard';

function getServiceBaseUrl(): string {
	return vscode.workspace
		.getConfiguration('yunxiaoAgent')
		.get<string>('serviceBaseUrl', 'http://127.0.0.1:8002');
}

export function activate(context: vscode.ExtensionContext) {
	console.log('# [Extension] 云效 Agent 扩展已激活');

	const baseUrl = getServiceBaseUrl();
	const client = new AIClient(baseUrl);

	// 本地工具注册表：注册首个本地工具 fs.read_file
	const registry = new ToolRegistry();
	registry.register(new ReadFileTool());

	const router = new ToolRouter(registry);
	const eventBus = new EventBus();

	const config = vscode.workspace.getConfiguration('yunxiaoAgent');
	const sessionManager = new SessionManager({
		client,
		router,
		eventBus,
		toolTimeoutMs: config.get<number>('toolTimeoutMs', 30_000),
		getWorkspaceRoots: () => getWorkspaceRoots(),
		getMaxFileSize: () =>
			config.get<number>('maxFileSize', DEFAULT_MAX_FILE_SIZE),
	});

	const provider = new ChatViewProvider(context, {
		client,
		registry,
		sessionManager,
		eventBus,
	});

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('yunxiaoAgent.chatView', provider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// 保留命令，让用户可以通过命令面板聚焦侧边栏
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.openPanel', () => {
			vscode.commands.executeCommand('yunxiaoAgent.chatView.focus');
		})
	);

	// 新建会话命令（工具栏按钮触发）
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.newSession', () => {
			provider.triggerNewSession();
		})
	);
}

export function deactivate() {}
