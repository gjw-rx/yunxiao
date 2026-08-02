import * as vscode from 'vscode';
import { ChatViewProvider } from './chatPanel';
import { AIClient } from './aiClient';
import { ToolRegistry } from './core/toolRegistry';
import { ToolRouter } from './core/toolRouter';
import { EventBus } from './core/eventBus';
import { SessionManager } from './core/sessionManager';
import { ApprovalGateway } from './core/approvalGateway';
import { ReadFileTool, DEFAULT_MAX_FILE_SIZE } from './tools/fs/readFile';
import { WriteFileTool } from './tools/fs/writeFile';
import { ListDirTool } from './tools/fs/listDir';
import { SearchFilesTool } from './tools/fs/searchFiles';
import { DeleteFileTool } from './tools/fs/deleteFile';
import { MoveFileTool } from './tools/fs/moveFile';
import { CodeEditTool } from './tools/code/editFile';
import { DiffViewer } from './tools/diff/diffViewer';
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
	const eventBus = new EventBus();

	// 先创建 provider（作为审批 prompter 的实现方）
	const provider = new ChatViewProvider(context, {
		client,
		registry: new ToolRegistry(),
		sessionManager: null as unknown as SessionManager,
		eventBus,
	});

	// 审批网关：使用 webview 内嵌审批卡片
	const approval = new ApprovalGateway({
		prompter: {
			async prompt(ctx) {
				let filePath: string | undefined;
				try {
					const args = JSON.parse(ctx.summary.split('\n')[1] || '{}');
					filePath = args.file_path || args.path || args.src || undefined;
				} catch {
					// ignore
				}
				const callId = ctx.callId ?? `approval_${Date.now()}`;
				return provider.requestApproval(
					callId,
					ctx.toolName,
					ctx.summary,
					filePath,
					ctx.sessionId ?? ''
				);
			},
		},
	});

	// 本地工具注册表
	const registry = new ToolRegistry();
	registry.register(new ReadFileTool());
	registry.register(new WriteFileTool());
	registry.register(new ListDirTool());
	registry.register(new SearchFilesTool());
	registry.register(new DeleteFileTool());
	registry.register(new MoveFileTool());
	registry.register(
		new CodeEditTool({ approval, diffViewer: new DiffViewer() })
	);

	const router = new ToolRouter(registry, approval);

	const config = vscode.workspace.getConfiguration('yunxiaoAgent');
	const sessionManager = new SessionManager({
		client,
		router,
		eventBus,
		approval,
		toolTimeoutMs: config.get<number>('toolTimeoutMs', 30_000),
		getWorkspaceRoots: () => getWorkspaceRoots(),
		getMaxFileSize: () =>
			config.get<number>('maxFileSize', DEFAULT_MAX_FILE_SIZE),
	});

	// 回填 provider 的依赖（解决循环依赖：provider -> approval -> provider）
	(provider as unknown as { _registry: ToolRegistry; _sessionManager: SessionManager })._registry = registry;
	(provider as unknown as { _registry: ToolRegistry; _sessionManager: SessionManager })._sessionManager = sessionManager;

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
