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
import { RollbackJournal } from './core/rollbackJournal';
import { ChangeJournal } from './core/changeJournal';
import { ApprovalGateway } from './core/approvalGateway';
import { LocalSessionManager } from './core/localSessionManager';
import { SessionPlanModeStore } from './core/planModeStore';
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
import { MessageStore, migrateLegacyWorkspaceState, type WorkspaceState } from './memory/messageStore';
import { SessionFileStore } from './memory/sessionFileStore';
import { SessionTodoStore } from './memory/sessionTodoStore';
import { aggregateTokenUsage, type UsageGranularity } from './memory/tokenUsageStats';

import { AgentLoop } from './agent/agentLoop';
import type { CompactionConfig } from './agent/compaction';
import { TodoWriteTool } from './tools/todo/todoWrite';
import { McpClientManager } from './mcp/manager';
import { McpConfigStore } from './mcp/configStore';
import type { McpServerRuntimeConfig, McpServerView } from './mcp/types';
import { HooksConfigStore, MementoHooksConfigStorage } from './hook/hooksConfigStore';
import { HookManager } from './hook/hookManager';
import { RtkTransformHook } from './hook/rtkAdapter';
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

	try {
		await _activate(context);
	} catch (err) {
		logger.error('[Extension] 激活失败:', err instanceof Error ? err.stack ?? err.message : err);
		throw err;
	}
}

/** 激活期持有的文件存储（deactivate 时等待待提交写入结算用）。 */
let activeFileStore: SessionFileStore | undefined;

async function _activate(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('yunxiaoAgent');
	const eventBus = new EventBus();

	// 工作区根（会话存储按 workspace 隔离）
	const workspaceRoots = getWorkspaceRoots();
	const workspaceRoot = workspaceRoots[0] ?? process.cwd();

	// 消息存储：~/.yunForce JSONL 文件后端（会话历史可长期保留、可查看、可迁移）
	activeFileStore = new SessionFileStore(workspaceRoot);
	const fileStore = activeFileStore;
	await migrateLegacyMessages(context, fileStore);
	const messageStore = new MessageStore(fileStore);
	const todoStore = new SessionTodoStore(fileStore);
	// Plan 模式状态服务：四阶段状态转换、工具策略与类型化事件（装配到路由/AgentLoop/会话/UI）
	const planModeStore = new SessionPlanModeStore(fileStore, eventBus);
	// 回滚快照：与会话存储同 workspace 隔离目录，记录写文件工具改动前的状态
	const rollbackJournal = new RollbackJournal(path.join(fileStore.sessionDirPath, 'rollback'));
	const changeJournal = new ChangeJournal(path.join(fileStore.sessionDirPath, 'changes'));

	// 本地工具注册表
	const registry = new ToolRegistry();

	// 先创建 provider（作为审批 prompter 的实现方）
	const provider = new ChatViewProvider(context, {
		sessionManager: null as unknown as LocalSessionManager,
		registry,
		eventBus,
		todoStore,
		changeJournal,
		planModeStore,
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
	registry.register(new CodeEditTool({ approval }));

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
	registry.register(new TodoWriteTool(todoStore, eventBus));

	// Skill 系统：默认项目 Skill 目录为 .claude/skills，按「配置来源」同步生态 Skill（默认 claude）。
	// 不再读取 yunxiaoAgent.skills.directories / yunxiaoAgent.sync.source VS Code 配置。
	const skillRegistry = new SkillRegistry();
	registry.register(new SkillTool(skillRegistry));

	// MCP Client Manager：后台渐进连接 MCP Server，工具动态注册到 ToolRegistry。
	// MCP 失败不得阻塞 Webview、本地工具或 Skill 初始化。
	const mcpStore = new McpConfigStore(context);
	const workspaceTrusted = vscode.workspace.isTrusted ?? true;
	const mcpManager = new McpClientManager({
		registry,
		workspaceTrusted,
		workspaceCwd: workspaceRoot,
		callbacks: {
			onStatusChange: (serverId, status, error) => {
				logger.log(`[Extension] MCP 状态变更 serverId=${serverId} status=${status}${error ? ` error=${error.message}` : ''}`);
				void provider.pushMcpSnapshot().catch((err) => {
					logger.error(`[Extension] 推送 MCP 状态快照失败 serverId=${serverId}: ${err instanceof Error ? err.message : String(err)}`);
				});
			},
			onInstructions: (serverId, instructions) => {
				logger.log(`[Extension] MCP instructions ${instructions ? '发布' : '移除'} serverId=${serverId}`);
			},
		},
	});
	context.subscriptions.push({ dispose: () => { void mcpManager.dispose(); } });

	/**
	 * 读取当前启用的 MCP Server，并装配运行时所需的 SecretStorage 值。
	 *
	 * @returns 持久化 revision 与可连接 Server 配置
	 */
	const loadEnabledMcpConfigs = async (): Promise<{ readonly revision: number; readonly configs: Map<string, McpServerRuntimeConfig> }> => {
		const doc = await mcpStore.getDocument();
		const configs = new Map<string, McpServerRuntimeConfig>();
		for (const serverId of Object.keys(doc.servers)) {
			const config = doc.servers[serverId];
			if (!config.enabled) {
				continue;
			}
			const runtime = await mcpStore.getRuntimeConfig(serverId);
			if (runtime) {
				configs.set(serverId, runtime);
			}
		}
		return { revision: doc.revision, configs };
	};

	/**
	 * 将最新私有 MCP 配置应用到 Manager；失败仅记录诊断，不能阻塞主流程。
	 *
	 * @returns 运行时应用完成后的 Promise
	 */
	const applyMcpConfig = async (): Promise<void> => {
		try {
			const { revision, configs } = await loadEnabledMcpConfigs();
			await mcpManager.applyConfig(revision, configs);
			logger.log(`[Extension] MCP 配置已应用 revision=${revision} serverCount=${configs.size}`);
		} catch (err) {
			logger.error(`[Extension] MCP 配置应用失败（不阻塞主流程）: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	/**
	 * 合并 Store 配置与 Manager 运行时状态，构造设置页所需的完整非敏感快照。
	 *
	 * @returns 所有已保存 MCP Server 的设置视图
	 */
	const getMcpSnapshot = async (): Promise<readonly McpServerView[]> => {
		const configured = await mcpStore.getSettingsView();
		const runtimeById = new Map(mcpManager.getSettingsSnapshot().servers.map((server) => [server.id, server]));
		return configured.map(({ id, config }) => {
			const runtime = runtimeById.get(id);
			if (runtime) {
				return { ...runtime, configuredTransport: config.type, enabled: config.enabled, config };
			}
			return {
				id,
				configuredTransport: config.type,
				enabled: config.enabled,
				status: config.enabled ? (workspaceTrusted ? 'connecting' : 'waiting_workspace_trust') : 'disabled',
				toolCount: 0,
				tools: [],
				config,
			};
		});
	};

	/**
	 * 应用最新 MCP 配置后主动刷新已打开的设置页快照。
	 *
	 * @returns 配置应用与快照推送完成后的 Promise
	 */
	const applyMcpConfigAndPushSnapshot = async (): Promise<void> => {
		await applyMcpConfig();
		await provider.pushMcpSnapshot();
	};

	// 后台渐进连接 MCP Server（不阻塞激活）
	void applyMcpConfig();

	// 将 skillRegistry 注入 provider，供斜杠命令数据组装
	provider.setSkillRegistry(skillRegistry);

	// 先注册侧栏入口：首次 Skill 同步期间也能展示加载视图。
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('yunxiaoAgent.chatView', provider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.openPanel', () => {
			provider.show();
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('yunxiaoAgent.newSession', () => {
			provider.triggerNewSession();
		})
	);

	// 生态配置同步（Claude / Trae / Agent 互斥）：按「配置来源」读取对应目录的 SKILL 并注册进 Skill 系统
	// （claude → 项目 .claude/skills（先加载，优先）与 ~/.claude/skills（后加载，同名跳过）；trae → ~/.trae(s) 与项目 .trae(s)/skills；agent → ~/.agents/skills；none → 不加载）。
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
						: source === 'agent'
							? [path.join(os.homedir(), '.agents', 'skills')]
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
	// 工具路由
	const metrics = new ReliabilityMetrics();
	const journal = new ToolExecutionJournal(context.workspaceState);

	// Hooks 运行时：配置 Store（私有用户级持久化，缺失时 RTK 默认禁用）+ HookManager。
	// 只注册扩展内置的受信任 Hook；不从工作区、网络、脚本路径或 npm 包加载第三方 Hook。
	const hooksConfigStore = new HooksConfigStore(new MementoHooksConfigStorage(context.globalState));
	const hookManager = new HookManager(hooksConfigStore);
	// RTK Transform Hook：仅优化本地 terminal_exec 命令，不调用 rtk init、不安装/升级 RTK、不注入模型提示词
	const rtkTransformHook = new RtkTransformHook(hooksConfigStore);
	hookManager.register(rtkTransformHook);

	const router = new ToolRouter(registry, approval, new SecurityAudit(metrics), journal, hookManager, planModeStore);

	// 模型配置与 LLM Provider（非敏感字段保存在用户全局 .yunForce/modelConfig，密钥仅存 SecretStorage）
	const modelStore = new ModelConfigStore(context, undefined, workspaceRoot);
	let modelConfig = await modelStore.getModelConfig();
	if (!modelConfig.apiKey) {
		logger.log('[Extension] 警告: 未配置 API Key，请在设置页配置模型 API Key');
	}
	if (!modelConfig.model) {
		logger.log('[Extension] 警告: 未配置模型名称，请在设置页配置模型名称');
	}
	let llmProvider = createProvider(modelConfig);

	// 上下文压缩配置：模型能力来自模型档案，自动策略来自原生 VSCode Settings。
	/** 根据当前模型和原生 VSCode Settings 读取压缩配置。 @param currentModel 当前模型配置。 @returns 压缩配置。 */
	const createCompactionConfig = (currentModel: ModelConfig): CompactionConfig => ({
		autoEnabled: config.get<boolean>('compaction.autoEnabled', true),
		triggerPercent: config.get<number>('compaction.triggerPercent', 75),
		tailPercent: config.get<number>('compaction.tailPercent', 20),
		maxContextTokens: currentModel.maxContextTokens ?? 262144,
		maxOutputTokens: currentModel.maxTokens,
	});
	const compactionConfig = createCompactionConfig(modelConfig);

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
			todoStore,
			planModeStore,
			rollbackRecorder: rollbackJournal,
			changeJournal,
			mcpInstructionsProvider: () => mcpManager.getInstructions(),
			hooks: hookManager,
		}
	);

	// 本地会话管理器
	const sessionManager = new LocalSessionManager(
		agentLoop,
		messageStore,
		rollbackJournal,
		workspaceRoot,
		changeJournal,
		planModeStore,
		todoStore,
		eventBus,
	);

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
			maxContextTokens: config.maxContextTokens ?? 262144,
		});
		provider.refreshModelInfo();
		logger.log('[Extension] 模型配置已保存并更新后续运行（进行中的会话不受影响）');
	};

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (!event.affectsConfiguration('yunxiaoAgent.compaction')) {
			return;
		}
		agentLoop.updateCompactionConfig(createCompactionConfig(modelConfig));
		logger.log('[Extension] 已应用 VSCode 原生上下文压缩设置变更');
	}));

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
		mcpStore,
		getMcpSnapshot,
		onMcpConfigChanged: applyMcpConfigAndPushSnapshot,
		onMcpReconnect: async (serverId: string): Promise<void> => {
			await mcpManager.reconnect(serverId);
		},
		hooksConfigStore,
		rtkTransformHook,
		// 用量统计：扫描当前工作区会话归档后按粒度聚合（本地时区自然边界），损坏归档标记 partial
		requestUsageStats: async (granularity: UsageGranularity, reference: string): Promise<ReturnType<typeof aggregateTokenUsage>> => {
			const ref = /^\d{4}-\d{2}-\d{2}$/.test(reference)
				? new Date(`${reference}T00:00:00`)
				: new Date();
			return aggregateTokenUsage(fileStore.scanTokenRecords(), granularity, ref);
		},
	});

	/**
	 * 在后台执行首次 Skill 同步，避免阻塞侧栏加载视图。
	 *
	 * @returns Promise<void>
	 */
	const initializeSkills = async (): Promise<void> => {
		const startedAt = Date.now();
		logger.log('[Extension] 开始后台初始化 Skill');
		try {
			await syncSkills();
			provider.refreshModelInfo();
			provider.setRuntimeStatus('ready');
			provider.refreshSlashCommands();
			logger.log(`[Extension] 后台初始化 Skill 完成 耗时=${Date.now() - startedAt}ms`);
		} catch (err) {
			logger.error(`[Extension] 后台初始化 Skill 失败 耗时=${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`);
			provider.setRuntimeStatus('failed', 'Skill 加载失败，请查看云效 Agent 日志。');
		}
	};
	void initializeSkills();
}

/**
 * 迁移旧 workspaceState 中的会话消息到文件存储（一次性、幂等）。
 * 全部会话落盘成功后才清理旧键，防止未落盘时清理导致数据丢失；
 * 任一迁移失败不阻塞插件启动，仅记录日志告警且保留原始数据。
 * @param context 扩展上下文
 * @param fileStore 文件存储
 */
async function migrateLegacyMessages(context: vscode.ExtensionContext, fileStore: SessionFileStore): Promise<void> {
	const result = await migrateLegacyWorkspaceState(context.workspaceState as WorkspaceState, fileStore);
	logger.log(`[Extension] 迁移旧会话数据 迁移=${result.migrated} 跳过=${result.skipped} 失败=${result.failed}`);
}

/**
 * 扩展停用：等待全部待提交会话记录结算后再退出。
 * 提交失败时记录包含 sessionId、recordSeq 与失败原因的中文日志（不阻塞 VSCode 停用）。
 * @returns 停用完成
 */
export async function deactivate() {
	const fileStore = activeFileStore;
	if (!fileStore) {
		return;
	}
	try {
		await fileStore.commit();
		logger.log('[Extension] 停用前全部待提交会话记录已结算');
	} catch (error) {
		logger.error(`[Extension] 停用前会话记录结算失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}
