import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
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
import { WebSearchTool } from './tools/web/webSearch';
import { TavilyWebSearchProvider } from './tools/web/tavilyProvider';
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
import { installSkillArchive, type SkillInstallResult } from './skill/skillInstaller';
import { ModelConfigStore } from './config/modelConfigStore';
import type { ModelConfig } from './config/modelConfig';
import {
	getSkillDirectories,
	getSyncSource,
	setSkillDirectories,
	setSyncSource,
	type SyncSource,
} from './config/syncConfig';
import { createProvider } from './llm/provider';
import { MessageStore } from './memory/messageStore';
import { SessionFileStore } from './memory/sessionFileStore';
import type { Message } from './memory/types';
import { AgentLoop } from './agent/agentLoop';
import type { CompactionConfig } from './agent/compaction';
import * as logger from './logger';

/**
 * 判断异常是否为 Node inspector 内部运行时噪音。
 * VSCode 调试扩展宿主（extensionHost）时，Node inspector 在向调试前端广播网络事件的过程中，
 * 可能在流式 HTTP 响应（如 SSE）上抛出 "Missing dataLength in event" 等内部错误；
 * 这类错误源于运行时自身，与扩展功能无关，不应作为 FATAL 弹窗打扰用户。
 *
 * @param err 捕获到的异常
 * @returns true 表示确认为 inspector 内部噪音，应仅记录日志而不弹窗
 */
function isInspectorRuntimeNoise(err: unknown): boolean {
	const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
	return (
		text.includes('Missing dataLength in event') ||
		text.includes('node:inspector') ||
		text.includes('node:internal/inspector')
	);
}

// 全局崩溃捕获：进程死之前把错误写进 OutputChannel + 弹窗通知
process.on('uncaughtException', (err) => {
	if (isInspectorRuntimeNoise(err)) {
		logger.log('[Extension] 忽略 Node inspector 运行时噪音（非扩展错误）:', err instanceof Error ? err.stack ?? err.message : err);
		return;
	}
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

	// 工作区根（会话存储按 workspace 隔离）
	const workspaceRoots = getWorkspaceRoots();
	const workspaceRoot = workspaceRoots[0] ?? process.cwd();

	// 消息存储：~/.yunForce JSONL 文件后端（会话历史可长期保留、可查看、可迁移）
	const fileStore = new SessionFileStore(workspaceRoot);
	await migrateLegacyMessages(context, fileStore);
	const messageStore = new MessageStore(fileStore);

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

	// 外部网络检索（Tavily）：未配置启用项或 API Key 时 web_search 返回不可用错误，不发起网络请求
	registry.register(new WebSearchTool({ provider: new TavilyWebSearchProvider() }));

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

	// Skill 系统：默认项目 Skill 目录为 .claude/skills，按「配置来源」同步生态 Skill（默认 claude）。
	// 不再读取 yunxiaoAgent.skills.directories / yunxiaoAgent.sync.source VS Code 配置。
	const skillRegistry = new SkillRegistry();
	registry.register(new SkillTool(skillRegistry));

	// 将 skillRegistry 注入 provider，供斜杠命令数据组装
	provider.setSkillRegistry(skillRegistry);

	// 生态配置同步（Claude / Trae 二选一）：按「配置来源」读取对应目录的 SKILL 并注册进 Skill 系统
	// （claude → 项目 .claude/skills（先加载，优先）与 ~/.claude/skills（后加载，同名跳过）；trae → ~/.trae(s) 与项目 .trae(s)/skills；none → 不加载）。
	// 记录本次同步注册的 skill 名，切换来源或安装刷新时据此卸载，避免多套生态配置叠加。
	// 同步走串行链：来源快速切换/安装刷新时按顺序执行，避免并发卸载/注册导致 skill 注册状态错乱。
	let syncedSkillNames: string[] = [];
	let syncChain: Promise<void> = Promise.resolve();
	const syncSkills = (): Promise<void> => {
		const run = async (): Promise<void> => {
			for (const name of syncedSkillNames) {
				skillRegistry.unregister(name);
				logger.log(`[Extension] 卸载生态配置 Skill name=${name}`);
			}
			syncedSkillNames = [];
			const source = getSyncSource(context.globalState);
			// 实时获取工作区根（激活后新打开文件夹也能立即生效）
			const workspaceRoot = getWorkspaceRoots()[0] ?? process.cwd();
			const configuredDirs = getSkillDirectories(context.globalState)
				.map((dir) => path.join(workspaceRoot, dir));
			const sourceDirs =
				source === 'claude'
					? [
						path.join(workspaceRoot, '.claude', 'skills'),
						path.join(os.homedir(), '.claude', 'skills'),
					]
					: source === 'trae'
						? [
							path.join(os.homedir(), '.trae', 'skills'),
							path.join(os.homedir(), '.trae-cn', 'skills'),
							path.join(workspaceRoot, '.trae', 'skills'),
							path.join(workspaceRoot, '.trae-cn', 'skills'),
						]
					: [];
			const syncDirs = [...configuredDirs, ...sourceDirs];
			for (const dir of syncDirs) {
				const loaded = await loadSkillsFromDirectory(dir);
				for (const skill of loaded) {
					// 去重：先加载的目录优先（项目 .claude/skills 先于用户级），后续目录同名不覆盖（仅补缺）
					if (skillRegistry.get(skill.name)) {
						logger.log(`[Extension] 跳过同名 Skill（先加载目录优先） name=${skill.name} 目录=${dir}`);
						continue;
					}
					skillRegistry.register(skill);
					syncedSkillNames.push(skill.name);
				}
				if (loaded.length > 0) {
					logger.log(`[Extension] 从生态配置目录加载了 ${loaded.length} 个 Skill: ${dir}`);
				}
			}
			provider.refreshSlashCommands();
		};
		syncChain = syncChain.then(run, run);
		return syncChain;
	};
	await syncSkills();

	// 工具路由
	const metrics = new ReliabilityMetrics();
	const journal = new ToolExecutionJournal(context.workspaceState);
	const router = new ToolRouter(registry, approval, new SecurityAudit(metrics), journal);

	// 模型配置与 LLM Provider（非敏感字段按工作区保存在 .yunForce/modelConfig，密钥仅存 SecretStorage）
	const modelStore = new ModelConfigStore(context, workspaceRoot);
	let modelConfig = await modelStore.getModelConfig();
	if (!modelConfig.apiKey) {
		logger.log('[Extension] 警告: 未配置 API Key，请在设置页配置模型 API Key');
	}
	if (!modelConfig.model) {
		logger.log('[Extension] 警告: 未配置模型名称，请在设置页配置模型名称');
	}
	let llmProvider = createProvider(modelConfig);

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
			readMaxLines: config.get<number>('readFile.maxLines', 2000),
			readMaxBytes: config.get<number>('readFile.maxBytes', 50 * 1024),
			readMaxLineLength: config.get<number>('readFile.maxLineLength', 2000),
			governMaxLines: config.get<number>('toolResult.maxLines', 2000),
			governMaxBytes: config.get<number>('toolResult.maxBytes', 50 * 1024),
			toolTimeoutMs: config.get<number>('toolTimeoutMs', 30_000),
			terminalOutputLimit: config.get<number>('terminalOutputLimit', 10_000),
			toolResultLimit: config.get<number>('toolResultLimit', 10_000),
			agentPrompt: config.get<string>('agent.systemPrompt', '') || undefined,
			skillRegistry,
			syncSource: () => getSyncSource(context.globalState),
			compaction: compactionConfig,
		}
	);

	// 本地会话管理器
	const sessionManager = new LocalSessionManager(agentLoop, messageStore);

	// 回填 provider 的依赖（解决循环依赖：provider -> approval -> provider）
	(provider as unknown as { _sessionManager: LocalSessionManager })._sessionManager = sessionManager;

	// 模型配置保存后的安全更新时机：重建 provider 并更新 AgentLoop 配置，
	// 仅影响保存完成后启动的新运行（AgentLoop 对进行中的 run 持有 provider 快照，不中途切换）
	const applyModelConfig = (config: ModelConfig): void => {
		modelConfig = config;
		llmProvider = createProvider(config);
		agentLoop.updateProvider(llmProvider);
		agentLoop.updateModelConfig({
			model: config.model,
			providerId: config.provider,
			temperature: config.temperature,
			maxTokens: config.maxTokens,
		});
		provider.refreshModelInfo();
		logger.log('[Extension] 模型配置已保存并更新后续运行（进行中的会话不受影响）');
	};

	// 设置面板依赖注入：模型存储、配置来源读写、Skill 安装（成功后重新同步并刷新斜杠菜单）
	provider.setSettingsDeps({
		modelStore,
		getSyncSource: () => getSyncSource(context.globalState),
		getSkillDirectories: () => getSkillDirectories(context.globalState),
		setSyncSource: async (source: SyncSource): Promise<SyncSource> => {
			const previous = getSyncSource(context.globalState);
			const effective = setSyncSource(context.globalState, source);
			try {
				await syncSkills();
			} catch (err) {
				// 同步失败时回滚存储，避免"存储声称新来源但注册表未同步"的不一致
				setSyncSource(context.globalState, previous);
				logger.error(`[Extension] 配置来源切换同步失败，已回滚 source=${previous}: ${err instanceof Error ? err.message : String(err)}`);
				throw err;
			}
			return effective;
		},
		setSkillDirectories: async (directories: readonly string[]): Promise<string[]> => {
			const previous = getSkillDirectories(context.globalState);
			const effective = setSkillDirectories(context.globalState, directories);
			try {
				await syncSkills();
			} catch (err) {
				setSkillDirectories(context.globalState, previous);
				logger.error(`[Extension] Skill 目录重新加载失败，已回滚: ${err instanceof Error ? err.message : String(err)}`);
				throw err;
			}
			return effective;
		},
		getModelName: () => modelConfig.model,
		uploadSkillArchive: async (): Promise<SkillInstallResult> => {
			const selected = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: { 'Skill ZIP 包': ['zip'] },
				openLabel: '上传并安装 Skill',
			});
			if (!selected?.[0]) {
				return { ok: false, reason: '未选择 ZIP 文件' };
			}
			// 实时获取工作区根（激活后新打开文件夹也能安装）
			const result = await installSkillArchive(selected[0].fsPath, getWorkspaceRoots());
			if (result.ok) {
				// 重新同步生态 Skill（含新安装的项目 .claude/skills）并刷新斜杠菜单与设置页列表
				await syncSkills();
			}
			return result;
		},
		onModelConfigSaved: applyModelConfig,
	});

	// 侧边栏 activity bar 图标入口：点击展开容器时 provider 在侧栏初始化聊天视图（见 ChatViewProvider.resolveWebviewView）
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('yunxiaoAgent.chatView', provider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// 打开对话命令：聚焦云效 Agent 侧栏视图
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.openPanel', () => {
			provider.show();
		})
	);

	// 新建会话命令（工具栏按钮触发）
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.newSession', () => {
			provider.triggerNewSession();
		})
	);
}

/**
 * 迁移旧 workspaceState 中的会话消息到文件存储（一次性、幂等）。
 * 已迁移的会话（索引已有条目）跳过，避免上次中断后重复追加；
 * 全部落盘完成后再清理旧键，防止清理后数据丢失。
 * @param context 扩展上下文
 * @param fileStore 文件存储
 */
async function migrateLegacyMessages(context: vscode.ExtensionContext, fileStore: SessionFileStore): Promise<void> {
	const legacy = context.workspaceState.get<Record<string, Message[]>>('yunxiaoAgent.messages');
	if (!legacy || Object.keys(legacy).length === 0) {
		return;
	}
	let migrated = 0;
	let skipped = 0;
	for (const [sessionId, messages] of Object.entries(legacy)) {
		if (fileStore.getSession(sessionId)) {
			skipped++;
			continue;
		}
		try {
			fileStore.createSession(sessionId);
			for (const m of messages) {
				fileStore.appendMessage(sessionId, m);
			}
			migrated++;
		} catch (err) {
			logger.error(`[Extension] 迁移会话失败 sessionId=${sessionId}:`, err instanceof Error ? err.message : String(err));
		}
	}
	// 等待全部会话落盘后再清理旧键
	await fileStore.flush();
	void context.workspaceState.update('yunxiaoAgent.messages', undefined).then(undefined, () => {
		logger.error('[Extension] 清理旧 workspaceState 键失败（忽略）');
	});
	logger.log(`[Extension] 迁移旧会话数据完成 迁移=${migrated} 跳过=${skipped}`);
}

export function deactivate() { }
