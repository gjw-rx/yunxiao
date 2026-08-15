/**
 * MCP Client Manager — 运行时核心协调器。
 *
 * 职责：
 * - 持有配置 revision、连接表（serverId → McpServerConnection）
 * - 通过 applyConfig(revision, configs) 串行 diff 并协调连接生命周期
 * - 桥接 Connection 到 ToolRegistry（owner-scoped register/replace/unregister）
 * - 收集 instructions 快照与设置页非敏感快照
 * - 状态订阅（回调通知 Host → Webview 推送）
 * - 工作区信任门控：不可信时保持 waiting_workspace_trust，不创建 Connection
 * - dispose：并行有界关闭全部 Connection，下线所有工具
 *
 * 安全约定：Manager 不直接持有凭据、URL、进程或 SDK Client。
 * Transport 细节由 McpServerConnection 与 TransportFactory 封装。
 * 协议细节不进入 AgentLoop，ToolRouter 不对 Transport 分支。
 */
import * as logger from '../logger';
import { McpServerConnection } from './connection';
import { McpToolAdapter, type McpToolAdapterManager } from './toolAdapter';
import { McpToolNameMapper } from './toolNameMapper';
import type { ToolRegistry } from '../core/toolRegistry';
import type { ToolExecutionResult } from '../tools/baseTool';
import type {
	McpDiscoveredTool,
	McpError as McpFailure,
	McpServerInstructions,
	McpServerRuntimeConfig,
	McpServerStatus,
	McpServerView,
	McpSettingsSnapshot,
	McpToolView,
	McpToolCatalogEntry,
} from './types';

/** Manager 构造参数。 */
export interface McpClientManagerOptions {
	/** 工具注册表（owner-scoped 动态注册）。 */
	readonly registry: ToolRegistry;
	/** 工作区是否可信；不可信时不创建 Connection。 */
	readonly workspaceTrusted: boolean;
	/** 状态/instructions 变化回调。 */
	readonly callbacks: McpManagerCallbacks;
	/** 当前主工作区根（STDIO cwd 缺省展开用）。 */
	readonly workspaceCwd?: string;
}

/** Manager 向外发出的回调集合。 */
export interface McpManagerCallbacks {
	/** 状态迁移通知（含可选错误）。 */
	readonly onStatusChange: (serverId: string, status: McpServerStatus, error?: McpFailure) => void;
	/** instructions 快照发布/移除。 */
	readonly onInstructions: (serverId: string, instructions: McpServerInstructions | undefined) => void;
}

/** 单个 Server 的运行时上下文。 */
interface ServerContext {
	/** Connection 实例。 */
	readonly connection: McpServerConnection;
	/** 运行时配置（含秘密值）。 */
	readonly config: McpServerRuntimeConfig;
	/** 该 Server 的工具 catalog（不可变）。 */
	catalog: readonly McpToolCatalogEntry[];
	/** instructions 快照。 */
	instructions: McpServerInstructions | undefined;
	/** 当前 revision。 */
	revision: number;
}

/** owner 前缀（mcp:<serverId>）。 */
function ownerKey(serverId: string): string {
	return `mcp:${serverId}`;
}

/**
 * 判断两个运行时配置是否一致，避免无变更时重建 Connection。
 *
 * @param left 当前已应用的运行时配置
 * @param right 待应用的运行时配置
 * @returns 配置内容是否完全一致
 */
function sameRuntimeConfig(left: McpServerRuntimeConfig, right: McpServerRuntimeConfig): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** 工具发现结果（Connection 回调传入）。 */
interface DiscoveredToolsEvent {
	readonly serverId: string;
	readonly tools: readonly McpDiscoveredTool[];
}

export class McpClientManager {
	private readonly _registry: ToolRegistry;
	private _workspaceTrusted: boolean;
	private readonly _workspaceCwd?: string;
	private readonly _callbacks: McpManagerCallbacks;
	private readonly _contexts = new Map<string, ServerContext>();
	private _revision = 0;
	private _disposed = false;

	/** 构造。 */
	constructor(opts: McpClientManagerOptions) {
		this._registry = opts.registry;
		this._workspaceTrusted = opts.workspaceTrusted;
		this._workspaceCwd = opts.workspaceCwd;
		this._callbacks = opts.callbacks;
	}

	/**
	 * 串行应用配置快照：diff 当前运行配置与新配置，协调连接生命周期。
	 *
	 * - 未变化的 Server 复用现有 Connection
	 * - 新增/编辑的 Server 先下线旧工具并关闭旧 Connection，再创建新 Connection
	 * - 禁用的 Server 下线工具并关闭 Connection
	 * - 删除的 Server 下线工具、关闭 Connection
	 * - 过期 revision 的事件被丢弃
	 *
	 * @param revision 递增的配置版本号
	 * @param configs serverId → 运行时配置（含秘密值，仅 enabled 的 Server）
	 */
	async applyConfig(revision: number, configs: ReadonlyMap<string, McpServerRuntimeConfig>): Promise<void> {
		if (this._disposed) {
			return;
		}
		// revision gate：过期配置丢弃
		if (revision <= this._revision) {
			logger.log(`# [McpManager] 过期 revision 丢弃 revision=${revision} current=${this._revision}`);
			return;
		}
		this._revision = revision;
		logger.log(`# [McpManager] applyConfig 开始 revision=${revision} serverCount=${configs.size}`);

		// diff：找出新增/编辑、删除/禁用的 Server
		const newServerIds = new Set(configs.keys());
		const removedServerIds: string[] = [];
		for (const existingId of this._contexts.keys()) {
			if (!newServerIds.has(existingId)) {
				removedServerIds.push(existingId);
			}
		}

		// 先下线删除的 Server
		for (const serverId of removedServerIds) {
			await this._teardownServer(serverId);
		}

		// 对新增/编辑的 Server 创建连接
		for (const [serverId, config] of configs) {
			const existing = this._contexts.get(serverId);
			if (existing && sameRuntimeConfig(existing.config, config)) {
				// 配置未变化时复用现有 Connection。
				continue;
			}
			if (existing) {
				await this._teardownServer(serverId);
			}
			await this._setupServer(serverId, config, revision);
		}

		logger.log(`# [McpManager] applyConfig 完成 revision=${revision}`);
	}

	/**
	 * 调用 MCP 工具：路由到指定 Server 的 Connection。
	 *
	 * @param serverId MCP Server ID
	 * @param nativeToolName Server 端原始工具名
	 * @param args 经本地校验的参数
	 * @param signal AgentLoop AbortSignal
	 * @returns 归一化结果（不含 call_id）
	 */
	async callTool(serverId: string, nativeToolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
		if (this._disposed) {
			return { status: 'error', result: `MCP Server ${serverId} 不可用`, metadata: { retryable: false } };
		}
		const ctx = this._contexts.get(serverId);
		if (!ctx) {
			return { status: 'error', result: `MCP Server ${serverId} 不可用`, metadata: { retryable: false } };
		}
		return ctx.connection.callTool(nativeToolName, args, signal);
	}

	/**
	 * 重连指定 Server：不改 Store，只重建 Connection。
	 *
	 * @param serverId MCP Server ID
	 */
	async reconnect(serverId: string): Promise<void> {
		if (this._disposed) {
			return;
		}
		const ctx = this._contexts.get(serverId);
		if (!ctx) {
			return;
		}
		logger.log(`# [McpManager] 重连 serverId=${serverId}`);
		await this._teardownServer(serverId);
		await this._setupServer(serverId, ctx.config, this._revision);
	}

	/**
	 * 获取 instructions 快照列表（仅 ready Server）。
	 * @returns instructions 列表
	 */
	getInstructions(): readonly McpServerInstructions[] {
		const result: McpServerInstructions[] = [];
		for (const ctx of this._contexts.values()) {
			if (ctx.instructions) {
				result.push(ctx.instructions);
			}
		}
		return result;
	}

	/**
	 * 获取设置页非敏感快照。
	 * @returns MCP 设置快照
	 */
	getSettingsSnapshot(): McpSettingsSnapshot {
		const servers: McpServerView[] = [];
		for (const [serverId, ctx] of this._contexts) {
			servers.push(this._buildServerView(serverId, ctx));
		}
		return { servers };
	}

	/**
	 * 设置工作区信任状态。
	 * 不可信时下线全部工具并关闭全部 Connection；恢复可信后重新连接最新 revision 的 enabled 配置。
	 *
	 * @param trusted 是否可信
	 * @param configs 恢复可信时用于重连的配置（serverId → 运行时配置）
	 */
	async setWorkspaceTrusted(trusted: boolean, configs?: ReadonlyMap<string, McpServerRuntimeConfig>): Promise<void> {
		if (this._disposed) {
			return;
		}
		this._workspaceTrusted = trusted;
		if (!trusted) {
			// 不可信：下线全部
			logger.log('# [McpManager] 工作区不可信，下线全部 Server');
			for (const serverId of [...this._contexts.keys()]) {
				await this._teardownServer(serverId);
			}
		} else if (configs) {
			// 恢复可信：重连最新配置
			logger.log('# [McpManager] 工作区恢复可信，重连配置');
			await this.applyConfig(this._revision + 1, configs);
		}
	}

	/**
	 * 有界释放：停止接受新调用、并行关闭全部 Connection、下线所有工具。
	 */
	async dispose(): Promise<void> {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		logger.log('# [McpManager] 开始释放全部 Server');
		const serverIds = [...this._contexts.keys()];
		await Promise.all(serverIds.map((id) => this._teardownServer(id)));
		logger.log('# [McpManager] 已释放全部 Server');
	}

	// ── 内部实现 ──

	/**
	 * 创建并连接一个 Server。
	 * 不可信工作区：Connection 保持 waiting_workspace_trust。
	 */
	private async _setupServer(serverId: string, config: McpServerRuntimeConfig, revision: number): Promise<void> {
		const connection = new McpServerConnection({
			serverId,
			config,
			workspaceTrusted: this._workspaceTrusted,
			workspaceCwd: this._workspaceCwd,
			callbacks: {
				onStatusChange: (id, status, error) => this._onConnectionStatus(id, status, error),
				onToolsPublished: (id, tools) => this._onToolsPublished(id, tools),
				onInstructions: (id, instr) => this._onInstructions(id, instr),
			},
		});
		const ctx: ServerContext = {
			connection,
			config,
			catalog: [],
			instructions: undefined,
			revision,
		};
		this._contexts.set(serverId, ctx);
		await connection.connect();
	}

	/** 下线一个 Server：移除工具、关闭 Connection。 */
	private async _teardownServer(serverId: string): Promise<void> {
		const ctx = this._contexts.get(serverId);
		if (!ctx) {
			return;
		}
		this._contexts.delete(serverId);
		// 下线工具
		this._registry.unregisterOwner(ownerKey(serverId));
		// 移除 instructions
		if (ctx.instructions) {
			this._callbacks.onInstructions(serverId, undefined);
		}
		// 有界关闭 Connection
		try {
			await ctx.connection.dispose();
		} catch (e) {
			logger.error(`# [McpManager] Connection 关闭失败 serverId=${serverId}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Connection 状态变化：转发到外部回调。 */
	private _onConnectionStatus(serverId: string, status: McpServerStatus, error?: McpFailure): void {
		this._callbacks.onStatusChange(serverId, status, error);
	}

	/** Connection 工具发布：构建 catalog、创建 Adapter、注册到 ToolRegistry。 */
	private _onToolsPublished(serverId: string, tools: readonly McpDiscoveredTool[]): void {
		const ctx = this._contexts.get(serverId);
		if (!ctx) {
			return;
		}
		// 过期 revision：丢弃迟到事件
		if (ctx.revision < this._revision) {
			logger.log(`# [McpManager] 过期工具发布丢弃 serverId=${serverId} revision=${ctx.revision} current=${this._revision}`);
			return;
		}
		// 空 tools：下线
		if (tools.length === 0) {
			this._registry.unregisterOwner(ownerKey(serverId));
			ctx.catalog = [];
			return;
		}
		// 构建 catalog
		const mapper = new McpToolNameMapper(tools.map((t) => ({
			serverId,
			nativeToolName: t.nativeToolName,
			description: t.description,
			inputSchema: t.inputSchema,
			...(t.annotations ? { annotations: t.annotations } : {}),
		})));
		const catalog = mapper.getCatalog();
		const adapters = catalog.map((entry) => new McpToolAdapter(entry, this._managerAdapter()));
		this._registry.replaceOwnerTools(ownerKey(serverId), adapters);
		ctx.catalog = catalog;
		logger.log(`# [McpManager] 工具已发布 serverId=${serverId} count=${tools.length}`);
	}

	/** Connection instructions 发布/移除。 */
	private _onInstructions(serverId: string, instructions: McpServerInstructions | undefined): void {
		const ctx = this._contexts.get(serverId);
		if (!ctx) {
			return;
		}
		ctx.instructions = instructions;
		this._callbacks.onInstructions(serverId, instructions);
	}

	/** 构造 Manager 自身的 McpToolAdapterManager 实现（Adapter 依赖此接口路由调用）。 */
	private _managerAdapter(): McpToolAdapterManager {
		return {
			callTool: (serverId, nativeToolName, args, signal) => this.callTool(serverId, nativeToolName, args, signal),
		};
	}

	/** 构造 ServerView（非敏感快照）。 */
	private _buildServerView(serverId: string, ctx: ServerContext): McpServerView {
		const config = ctx.config;
		const conn = ctx.connection;
		const tools: McpToolView[] = ctx.catalog.map((e) => ({ name: e.exposedName, description: e.description }));

		return {
			id: serverId,
			configuredTransport: config.type === 'stdio' ? 'stdio' : 'streamable-http',
			actualTransport: conn.actualTransport,
			enabled: true,
			status: conn.status,
			toolCount: ctx.catalog.length,
			tools,
			errorSummary: conn.error?.message,
			config: this._buildConfigView(config),
		};
	}

	/** 构造配置视图（非敏感）。 */
	private _buildConfigView(config: McpServerRuntimeConfig): McpServerView['config'] {
		if (config.type === 'stdio') {
			return {
				type: 'stdio',
				command: config.command,
				args: config.args,
				envKeys: Object.keys(config.env),
				cwd: config.cwd,
				enabled: config.enabled,
				connectTimeoutMs: config.connectTimeoutMs,
				callTimeoutMs: config.callTimeoutMs,
			};
		}
		return {
			type: 'streamable-http',
			url: config.url,
			headerNames: Object.keys(config.headers),
			legacySseFallback: config.legacySseFallback,
			enabled: config.enabled,
			connectTimeoutMs: config.connectTimeoutMs,
			callTimeoutMs: config.callTimeoutMs,
		};
	}
}
