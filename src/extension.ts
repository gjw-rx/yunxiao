import * as vscode from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './chatPanel';
import { ToolRegistry } from './core/toolRegistry';
import { ToolRouter } from './core/toolRouter';
import { SecurityAudit } from './core/securityAudit';
import { ReliabilityMetrics } from './core/reliabilityMetrics';
import { EventBus } from './core/eventBus';
import { ToolExecutionJournal } from './core/toolExecutionJournal';
import { ApprovalGateway } from './core/approvalGateway';
import { LocalSessionManager } from './core/localSessionManager';
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
import { GitLogTool } from './tools/git/gitLog';
import { GitDiffTool } from './tools/git/gitDiff';
import { GitCommitTool } from './tools/git/gitCommit';
import { GitBranchTool } from './tools/git/gitBranch';
import { GitStashTool } from './tools/git/gitStash';
import { getWorkspaceRoots } from './tools/fs/pathGuard';
import { SkillRegistry } from './skill/skillRegistry';
import { loadSkillsFromDirectory } from './skill/skillLoader';
import { SkillTool } from './skill/skillTool';
import { getModelConfig } from './config/modelConfig';
import { createProvider } from './llm/provider';
import { MessageStore } from './memory/messageStore';
import { AgentLoop } from './agent/agentLoop';
import type { CompactionConfig } from './agent/compaction';
import * as logger from './logger';

// 全局崩溃捕获：进程死之前把错误写进 OutputChannel + 弹窗通知
process.on('uncaughtException', (err) => {
	logger.notifyError('[FATAL] uncaughtException', err instanceof Error ? err.stack ?? err.message : err);
});
process.on('unhandledRejection', (reason) => {
	logger.notifyError('[FATAL] unhandledRejection', reason instanceof Error ? reason.stack ?? reason?.toString?.() ?? String(reason) : String(reason));
});

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
	const config = vscode.workspace.getConfiguration('yunxiaoAgent');
	const eventBus = new EventBus();

	// 消息存储
	const messageStore = new MessageStore(context.workspaceState);

	// 本地工具注册表
	const registry = new ToolRegistry();

	// 先创建 provider（作为审批 prompter 的实现方）
	const provider = new ChatViewProvider(context, {
		sessionManager: null as unknown as LocalSessionManager,
		registry,
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

	registry.register(new ReadFileTool());
	registry.register(new WriteFileTool());
	registry.register(new ListDirTool());
	registry.register(new SearchFilesTool());
	registry.register(new DeleteFileTool());
	registry.register(new MoveFileTool());
	registry.register(
		new CodeEditTool({ approval, diffViewer: new DiffViewer() })
	);

	// 代码智能工具（只读，无需审批）
	registry.register(new GetDiagnosticsTool());
	registry.register(new WorkspaceSymbolsTool());
	registry.register(new FindReferencesTool());
	registry.register(new GoToDefinitionTool());

	// 终端执行与 Git 集成
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
	registry.register(new GitLogTool());
	registry.register(new GitDiffTool());
	registry.register(new GitCommitTool());
	registry.register(new GitBranchTool());
	registry.register(new GitStashTool());

	// Skill 系统：扫描配置目录并注册，注册 skill 工具
	const skillRegistry = new SkillRegistry();
	const skillDirs = config.get<string[]>('skills.directories', ['.vscode/skills']);
	const workspaceRoots = getWorkspaceRoots();
	for (const dir of skillDirs) {
		const absDir = path.isAbsolute(dir) ? dir : path.join(workspaceRoots[0] ?? process.cwd(), dir);
		const loaded = await loadSkillsFromDirectory(absDir);
		for (const skill of loaded) {
			skillRegistry.register(skill);
		}
		if (loaded.length > 0) {
			logger.log(`[Extension] 从 ${absDir} 加载了 ${loaded.length} 个 Skill`);
		}
	}
	registry.register(new SkillTool(skillRegistry));

	// 工具路由
	const metrics = new ReliabilityMetrics();
	const journal = new ToolExecutionJournal(context.workspaceState);
	const router = new ToolRouter(registry, approval, new SecurityAudit(metrics), journal);

	// 模型配置与 LLM Provider
	const modelConfig = getModelConfig();
	if (!modelConfig.apiKey) {
		logger.log('[Extension] 警告: 未配置 API Key，请在设置中配置 yunxiaoAgent.model.apiKey');
	}
	if (!modelConfig.model) {
		logger.log('[Extension] 警告: 未配置模型名称，请在设置中配置 yunxiaoAgent.model.model');
	}
	const llmProvider = createProvider(modelConfig);

	// 上下文压缩配置（参考 opencode: keepTokens=8000, buffer=20000, 但调大以避免频繁压缩）
	const compactionConfig: CompactionConfig = {
		enabled: config.get<boolean>('compaction.enabled', true),
		keepTokens: config.get<number>('compaction.keepTokens', 24000),
		buffer: config.get<number>('compaction.buffer', 30000),
		contextWindow: 128000,
		messageThreshold: config.get<number>('compaction.messageThreshold', 40),
	};

	// Agent Loop
	const agentLoop = new AgentLoop(
		llmProvider,
		messageStore,
		router,
		registry,
		eventBus,
		{
			model: modelConfig.model,
			providerId: modelConfig.provider,
			temperature: modelConfig.temperature,
			maxTokens: modelConfig.maxTokens,
			maxSteps: config.get<number>('agent.maxSteps', 25),
			workspaceRoots,
			maxFileSize: config.get<number>('maxFileSize', DEFAULT_MAX_FILE_SIZE),
			toolTimeoutMs: config.get<number>('toolTimeoutMs', 30_000),
			terminalOutputLimit: config.get<number>('terminalOutputLimit', 10_000),
			toolResultLimit: config.get<number>('toolResultLimit', 10_000),
			agentPrompt: config.get<string>('agent.systemPrompt', '') || undefined,
			skillRegistry,
			compaction: compactionConfig,
		}
	);

	// 本地会话管理器
	const sessionManager = new LocalSessionManager(agentLoop, messageStore);

	// 回填 provider 的依赖（解决循环依赖：provider -> approval -> provider）
	(provider as unknown as { _sessionManager: LocalSessionManager })._sessionManager = sessionManager;

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
