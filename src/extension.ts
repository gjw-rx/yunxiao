import * as vscode from 'vscode';
import { ChatViewProvider } from './chatPanel';
import { AIClient } from './aiClient';
import { ToolRegistry } from './core/toolRegistry';
import { ToolRouter } from './core/toolRouter';
import { SecurityAudit } from './core/securityAudit';
import { ReliabilityMetrics } from './core/reliabilityMetrics';
import { EventBus } from './core/eventBus';
import { SessionManager } from './core/sessionManager';
import { RunStore } from './core/runStore';
import { ToolExecutionJournal } from './core/toolExecutionJournal';
import { ApprovalGateway } from './core/approvalGateway';
import { ReadFileTool, DEFAULT_MAX_FILE_SIZE } from './tools/fs/readFile';
import { WriteFileTool } from './tools/fs/writeFile';
import { ListDirTool } from './tools/fs/listDir';
import { SearchFilesTool } from './tools/fs/searchFiles';
import { DeleteFileTool } from './tools/fs/deleteFile';
import { MoveFileTool } from './tools/fs/moveFile';
import { CodeEditTool } from './tools/code/editFile';
import { GetDiagnosticsTool } from './tools/code/getDiagnostics';
import { WorkspaceSymbolsTool } from './tools/code/workspaceSymbols';
import { FindReferencesTool } from './tools/code/findReferences';
import { GoToDefinitionTool } from './tools/code/goToDefinition';
import { DiffViewer } from './tools/diff/diffViewer';
import { TerminalExecTool } from './tools/terminal/terminalExec';
import { ShellWhitelist } from './tools/terminal/shellWhitelist';
import { GitStatusTool } from './tools/git/gitStatus';
import { GitDiffTool } from './tools/git/gitDiff';
import { GitCommitTool } from './tools/git/gitCommit';
import { GitBranchTool } from './tools/git/gitBranch';
import { GitStashTool } from './tools/git/gitStash';
import { getWorkspaceRoots } from './tools/fs/pathGuard';
import * as logger from './logger';

// 全局崩溃捕获：进程死之前把错误写进 OutputChannel
process.on('uncaughtException', (err) => {
	logger.error('[FATAL] uncaughtException:', err instanceof Error ? err.stack ?? err.message : err);
});
process.on('unhandledRejection', (reason) => {
	logger.error('[FATAL] unhandledRejection:', reason instanceof Error ? reason.stack ?? reason?.toString?.() ?? String(reason) : String(reason));
});

function getServiceBaseUrl(): string {
	return vscode.workspace
		.getConfiguration('yunxiaoAgent')
		.get<string>('serviceBaseUrl', 'http://127.0.0.1:8002');
}

export async function activate(context: vscode.ExtensionContext) {
	logger.log('[Extension] 云效 Agent 扩展已激活');
	logger.show();

	try {
		await _activate(context);
	} catch (err) {
		logger.error('[Extension] 激活失败:', err instanceof Error ? err.stack ?? err.message : err);
		throw err;
	}
}

async function _activate(context: vscode.ExtensionContext) {

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
	const config = vscode.workspace.getConfiguration('yunxiaoAgent');
	registry.register(new ReadFileTool());
	registry.register(new WriteFileTool());
	registry.register(new ListDirTool());
	registry.register(new SearchFilesTool());
	registry.register(new DeleteFileTool());
	registry.register(new MoveFileTool());
	registry.register(
		new CodeEditTool({ approval, diffViewer: new DiffViewer() })
	);

	// Phase 3: 代码智能工具（只读，无需审批）
	registry.register(new GetDiagnosticsTool());
	registry.register(new WorkspaceSymbolsTool());
	registry.register(new FindReferencesTool());
	registry.register(new GoToDefinitionTool());

	// Phase 4: 终端执行与 Git 集成
	const shellWhitelist = new ShellWhitelist(
		config.get<string[]>('shellWhitelist', [])
	);
	registry.register(
		new TerminalExecTool({
			approval,
			shellWhitelist,
			terminalTimeoutMs: config.get<number>('terminalTimeoutMs', 300_000),
			terminalOutputLimit: config.get<number>('terminalOutputLimit', 10_000),
		})
	);
	registry.register(new GitStatusTool());
	registry.register(new GitDiffTool());
	registry.register(new GitCommitTool());
	registry.register(new GitBranchTool());
	registry.register(new GitStashTool());

	const metrics = new ReliabilityMetrics();
	const runStore = new RunStore(context.workspaceState);
	const journal = new ToolExecutionJournal(context.workspaceState);
	const router = new ToolRouter(registry, approval, new SecurityAudit(metrics), journal);

	const sessionManager = new SessionManager({
		client,
		router,
		eventBus,
		approval,
		metrics,
		runStore,
		toolTimeoutMs: config.get<number>('toolTimeoutMs', 30_000),
		getWorkspaceRoots: () => getWorkspaceRoots(),
		getMaxFileSize: () =>
			config.get<number>('maxFileSize', DEFAULT_MAX_FILE_SIZE),
		getTerminalOutputLimit: () =>
			config.get<number>('terminalOutputLimit', 10_000),
		getToolResultLimit: () => config.get<number>('toolResultLimit', 10_000),
		getToolTimeoutMs: (toolName) =>
			toolName === 'terminal.exec'
				? config.get<number>('terminalTimeoutMs', 300_000)
				: undefined,
	});
	for (const run of runStore.listRestorable()) {
		sessionManager.restoreRun(run);
	}

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

export function deactivate() { }
