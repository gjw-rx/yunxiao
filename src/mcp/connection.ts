/**
 * MCP Server Connection（任务 7.3 / 7.5 / 7.7 / 7.9）。
 *
 * 职责：一对一持有官方 Client 与 Transport Handle，管理单个 MCP Server 的状态机、
 * 握手、instructions 快照、工具分页发现、tools/call、取消/超时与有界释放。
 * Connection 不持有配置凭据，凭据由 Store 装配进运行时配置后传入；Transport 细节
 * 由 TransportFactory 封装。Connection 发布原始发现工具（McpDiscoveredTool），
 * 由 Manager 负责命名映射与目录构建。
 *
 * 状态机：waiting_workspace_trust → connecting → ready | error；dispose 进入 stopping。
 * 任一 Server 失败只影响自身，不影响其他 Server、本地工具或聊天主流程。
 *
 * 安全：日志只记录 Server ID、阶段、Transport、耗时与错误类别，不记录 env/header/URL 值。
 */
import * as logger from '../logger';
import { Client, McpError, ErrorCode, StreamableHTTPError, ToolListChangedNotificationSchema } from './sdk';
import { createStdioTransport, createStreamableHttpTransport, createLegacySseTransport, type McpTransportHandle } from './transportFactory';
import { normalizeCallToolResult, type McpCallToolResult } from './resultNormalizer';
import type { NormalizedMcpResult } from './resultNormalizer';
import type {
	McpActualTransport,
	McpDiscoveredTool,
	McpError as McpFailure,
	McpServerInstructions,
	McpServerRuntimeConfig,
	McpServerStatus,
	McpToolAnnotations,
} from './types';

/** instructions 单项最大字符数。 */
const INSTRUCTIONS_MAX_CHARS = 4000;
/** dispose 时等待 Client/Transport 关闭的有界超时（毫秒）。 */
const DISPOSE_CLOSE_TIMEOUT_MS = 3000;

/** Connection 向 Manager 发出的状态/工具/instructions 回调集合。 */
export interface McpConnectionCallbacks {
	/** 状态迁移通知（含可选错误）。 */
	readonly onStatusChange: (serverId: string, status: McpServerStatus, error?: McpFailure) => void;
	/** 工具列表原子发布（完整列表；空列表表示下线）。 */
	readonly onToolsPublished: (serverId: string, tools: readonly McpDiscoveredTool[]) => void;
	/** instructions 快照发布/移除（undefined 表示移除）。 */
	readonly onInstructions: (serverId: string, instructions: McpServerInstructions | undefined) => void;
}

/** McpServerConnection 构造参数。 */
export interface McpServerConnectionOptions {
	readonly serverId: string;
	/** 运行时配置（秘密已装配）。 */
	readonly config: McpServerRuntimeConfig;
	/** 工作区是否可信；不可信时保持 waiting_workspace_trust 不连接。 */
	readonly workspaceTrusted: boolean;
	/** 当前主工作区根，用于 STDIO cwd 缺省展开。 */
	readonly workspaceCwd?: string;
	/** Transport 工厂（测试可注入；缺省按配置类型分派）。 */
	readonly transportFactory?: (config: McpServerRuntimeConfig, workspaceCwd?: string) => McpTransportHandle;
	readonly callbacks: McpConnectionCallbacks;
}

/** 缺省 Transport 工厂：按配置 type 分派到 STDIO 或 Streamable HTTP。 */
function defaultTransportFactory(config: McpServerRuntimeConfig, workspaceCwd?: string): McpTransportHandle {
	if (config.type === 'stdio') {
		return createStdioTransport(config, workspaceCwd);
	}
	if (config.type === 'streamable-http') {
		return createStreamableHttpTransport(config);
	}
	throw new Error(`不支持的 MCP 配置类型：${(config as { type: string }).type}`);
}

/**
 * 单个 MCP Server 的连接生命周期管理。
 *
 * 不可重入：connect 只应调用一次；重建连接由 Manager 销毁旧 Connection 再创建新实例。
 */
export class McpServerConnection {
	private readonly _serverId: string;
	private readonly _config: McpServerRuntimeConfig;
	private readonly _workspaceTrusted: boolean;
	private readonly _workspaceCwd?: string;
	private readonly _transportFactory: (config: McpServerRuntimeConfig, workspaceCwd?: string) => McpTransportHandle;
	private readonly _callbacks: McpConnectionCallbacks;

	private _status: McpServerStatus = 'connecting';
	private _error: McpFailure | undefined;
	private _actualTransport: McpActualTransport | undefined;
	private _tools: readonly McpDiscoveredTool[] = [];
	private _instructions: McpServerInstructions | undefined;
	private _client: Client | undefined;
	private _handle: McpTransportHandle | undefined;
	private _disposed = false;

	/** Client 信息（扩展名 + 版本，用于 initialize 握手）。 */
	private static readonly _CLIENT_INFO = { name: 'yunxiao-agent', version: '0.2.0' } as const;

	constructor(opts: McpServerConnectionOptions) {
		this._serverId = opts.serverId;
		this._config = opts.config;
		this._workspaceTrusted = opts.workspaceTrusted;
		this._workspaceCwd = opts.workspaceCwd;
		this._transportFactory = opts.transportFactory ?? defaultTransportFactory;
		this._callbacks = opts.callbacks;
	}

	/** Server ID。 */
	get serverId(): string { return this._serverId; }
	/** 当前状态。 */
	get status(): McpServerStatus { return this._status; }
	/** 最近错误（status=error 时有效）。 */
	get error(): McpFailure | undefined { return this._error; }
	/** 实际 Transport（连接后有效）。 */
	get actualTransport(): McpActualTransport | undefined { return this._actualTransport; }
	/** 已发现的原始工具列表（只读快照）。 */
	get tools(): readonly McpDiscoveredTool[] { return this._tools; }
	/** instructions 快照。 */
	get instructions(): McpServerInstructions | undefined { return this._instructions; }
	/** STDIO stderr 有界尾部（仅 STDIO，未连接时为 undefined）。 */
	get stderrTail(): string | undefined { return this._handle?.stderrTail?.(); }

	/**
	 * 建立连接并完成初始化与工具发现。
	 *
	 * 不可信工作区直接保持 waiting_workspace_trust；连接/协议/发现失败进入 error，
	 * 不抛出，由 Manager 通过状态回调感知。任一失败不发布工具。
	 *
	 * @returns 连接完成（ready 或 error）
	 */
	async connect(): Promise<void> {
		if (this._disposed) {
			return;
		}
		if (!this._workspaceTrusted) {
			logger.log(`# [McpConnection] 工作区不可信，保持等待 serverId=${this._serverId}`);
			this._setStatus('waiting_workspace_trust');
			return;
		}

		this._setStatus('connecting');
		logger.log(`# [McpConnection] 开始连接 serverId=${this._serverId} type=${this._config.type}`);

		let handle: McpTransportHandle;
		try {
			handle = this._transportFactory(this._config, this._workspaceCwd);
		} catch (e) {
			await this._fail(classifyError(e, 'spawn'));
			return;
		}
		this._handle = handle;
		handle.transport.onclose = () => { void this._onTransportClosed(); };

		const client = new Client(McpServerConnection._CLIENT_INFO, {});
		this._client = client;

		try {
			await client.connect(handle.transport, { timeout: this._config.connectTimeoutMs });
		} catch (e) {
			// Legacy SSE 回退：仅对 streamable-http 配置且显式开启 fallback 时触发
			if (this._config.type === 'streamable-http' && this._config.legacySseFallback && isCompatFail(e)) {
				logger.log(`# [McpConnection] Streamable HTTP 兼容失败，尝试 legacy SSE 回退 serverId=${this._serverId}`);
				// 先释放第一套 Client/Transport，再创建 SSE Transport 重连
				await this._closeResources();
				const fallbackOk = await this._tryLegacySseFallback();
				if (fallbackOk) {
					await this._postConnectInit();
					return;
				}
				// SSE 回退也失败：使用原始兼容失败错误
				await this._fail(classifyConnectError(e));
				return;
			}
			const failure = classifyConnectError(e);
			logger.error(`# [McpConnection] 连接/握手失败 serverId=${this._serverId} category=${failure.category}`);
			await this._fail(failure);
			return;
		}

		this._actualTransport = handle.actualTransport;
		await this._postConnectInit();
	}

	/**
	 * 尝试 Legacy SSE 回退：创建 SSE Transport + 新 Client 并连接。
	 *
	 * @returns true=回退成功；false=回退失败（调用方进入 error）
	 */
	private async _tryLegacySseFallback(): Promise<boolean> {
		if (this._disposed) {
			return false;
		}
		let sseHandle: McpTransportHandle;
		try {
			sseHandle = createLegacySseTransport(this._config);
		} catch (e) {
			logger.error(`# [McpConnection] SSE Transport 创建失败 serverId=${this._serverId}: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
		this._handle = sseHandle;
		sseHandle.transport.onclose = () => { void this._onTransportClosed(); };

		const sseClient = new Client(McpServerConnection._CLIENT_INFO, {});
		this._client = sseClient;

		try {
			await sseClient.connect(sseHandle.transport, { timeout: this._config.connectTimeoutMs });
		} catch (e) {
			logger.error(`# [McpConnection] SSE 回退连接失败 serverId=${this._serverId}: ${e instanceof Error ? e.message : String(e)}`);
			await this._closeResources();
			return false;
		}

		this._actualTransport = sseHandle.actualTransport;
		logger.log(`# [McpConnection] SSE 回退成功 serverId=${this._serverId}`);
		return true;
	}

	/**
	 * 连接后初始化：发布 actualTransport、instructions、工具发现并进入 ready。
	 *
	 * 主连接和 SSE 回退连接共用此逻辑。任一失败进入 error，不发布半量工具。
	 */
	private async _postConnectInit(): Promise<void> {
		const client = this._client;
		if (!client || !this._handle) {
			return;
		}

		const capabilities = client.getServerCapabilities();
		const instructionsText = client.getInstructions();
		this._setInstructions(instructionsText);

		// 没有 tools capability：保持连接但不发布工具，工具数为零
		if (!capabilities?.tools) {
			logger.log(`# [McpConnection] Server 无 tools capability serverId=${this._serverId}`);
			this._publishTools([]);
			this._setStatus('ready');
			return;
		}

		// Server 声明 listChanged：注册通知处理，仅 ready 时触发重新完整分页发现
		if (capabilities.tools.listChanged && this._client) {
			this._client.setNotificationHandler(ToolListChangedNotificationSchema, () => { void this._onToolsChanged(); });
		}

		try {
			const tools = await this._discoverTools();
			this._publishTools(tools);
		} catch (e) {
			logger.error(`# [McpConnection] 工具发现失败 serverId=${this._serverId} category=${classifyError(e).category}`);
			// 发现失败：进入 error，不发布半量工具，并移除 instructions
			await this._fail(classifyError(e, 'discovery'));
			return;
		}

		logger.log(`# [McpConnection] 连接就绪 serverId=${this._serverId} tools=${this._tools.length} transport=${this._actualTransport}`);
		this._setStatus('ready');
	}

	/**
	 * 调用原始 MCP 工具并返回归一化结果（任务 7.7）。
	 *
	 * Transport、URL、command、headers、env 均不来自模型参数；arguments 由本地校验后透传。
	 * 每次调用绑定 AgentLoop AbortSignal 并应用 callTimeoutMs；用户取消返回 cancelled，
	 * 超时返回结构化 error。SDK 把取消与超时都包装为 McpError(RequestTimeout)，因此用
	 * `signal.aborted` 区分：true 为取消，false 为超时。每个调用只发起一次，不自动重放
	 * 可能已发送的业务调用；取消/超时后迟到的结果由 SDK 丢弃。
	 *
	 * @param nativeToolName Server 端原始工具名
	 * @param args 经本地校验的参数
	 * @param signal AgentLoop AbortSignal
	 * @returns 归一化结果（success / error / cancelled）
	 */
	async callTool(nativeToolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<NormalizedMcpResult> {
		if (this._disposed || this._status !== 'ready' || !this._client) {
			logger.error(`# [McpConnection] 调用被拒（连接不可用）serverId=${this._serverId} tool=${nativeToolName} status=${this._status}`);
			return {
				status: 'error',
				result: `MCP Server ${this._serverId} 不可用`,
				metadata: { retryable: false },
			};
		}
		// 调用前已取消：直接返回 cancelled，不发起请求
		if (signal?.aborted) {
			logger.log(`# [McpConnection] 调用前已取消 serverId=${this._serverId} tool=${nativeToolName}`);
			return { status: 'cancelled', result: 'MCP 调用已取消', metadata: { execution_state: 'unknown' } };
		}
		logger.log(`# [McpConnection] 发起调用 serverId=${this._serverId} tool=${nativeToolName}`);
		try {
			const result = await this._client.callTool(
				{ name: nativeToolName, arguments: args },
				undefined,
				{ signal, timeout: this._config.callTimeoutMs },
			) as unknown as McpCallToolResult;
			return normalizeCallToolResult(result);
		} catch (e) {
			// signal 已 abort：调用中触发取消（SDK 包装为 RequestTimeout，但 signal.aborted=true）
			if (signal?.aborted) {
				logger.log(`# [McpConnection] 调用已取消 serverId=${this._serverId} tool=${nativeToolName}`);
				return { status: 'cancelled', result: 'MCP 调用已取消', metadata: { execution_state: 'unknown' } };
			}
			const failure = classifyError(e);
			logger.error(`# [McpConnection] 调用失败 serverId=${this._serverId} tool=${nativeToolName} category=${failure.category}`);
			// 超时：调用可能已到达 Server 但结果未确认；业务调用一律不自动重放
			const metadata = failure.category === 'timeout'
				? { retryable: false, execution_state: 'unknown' as const }
				: { retryable: false };
			return { status: 'error', result: failure.message, metadata };
		}
	}

	/**
	 * 有界释放：停止接受新调用、关闭 Client/Transport/子进程（任务 7.9 增强取消与强制清理）。
	 */
	async dispose(): Promise<void> {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._setStatus('stopping');
		logger.log(`# [McpConnection] 开始释放 serverId=${this._serverId}`);
		await this._closeResources();
		this._publishTools([]);
		this._setInstructions(undefined);
		logger.log(`# [McpConnection] 已释放 serverId=${this._serverId}`);
	}

	// ── 内部实现 ──

	/** 分页 tools/list 直到无 nextCursor，返回完整原始工具列表。 */
	private async _discoverTools(): Promise<McpDiscoveredTool[]> {
		const client = this._client!;
		const all: McpDiscoveredTool[] = [];
		let cursor: string | undefined;
		for (; ;) {
			const params = cursor !== undefined ? { cursor } : undefined;
			const result = await client.listTools(params, { timeout: this._config.connectTimeoutMs });
			for (const tool of result.tools) {
				all.push(toDiscoveredTool(tool));
			}
			cursor = (result as { nextCursor?: string }).nextCursor;
			if (cursor === undefined) {
				break;
			}
		}
		return all;
	}

	/** 原子发布工具列表并更新本地快照。 */
	private _publishTools(tools: readonly McpDiscoveredTool[]): void {
		this._tools = tools;
		this._callbacks.onToolsPublished(this._serverId, tools);
	}

	/** 设置/移除 instructions 快照（带单项截断）并通知。 */
	private _setInstructions(text: string | undefined): void {
		if (!text) {
			if (this._instructions !== undefined) {
				this._instructions = undefined;
				this._callbacks.onInstructions(this._serverId, undefined);
			}
			return;
		}
		const truncated = text.length > INSTRUCTIONS_MAX_CHARS;
		const content = truncated ? text.slice(0, INSTRUCTIONS_MAX_CHARS) : text;
		this._instructions = { serverId: this._serverId, content, truncated };
		this._callbacks.onInstructions(this._serverId, this._instructions);
	}

	/** 状态迁移并通知。 */
	private _setStatus(status: McpServerStatus, error?: McpFailure): void {
		this._status = status;
		this._error = error;
		this._callbacks.onStatusChange(this._serverId, status, error);
	}

	/** 进入 error 终态：先下线工具/instructions 并迁移状态，再有界清理资源。 */
	private async _fail(failure: McpFailure): Promise<void> {
		this._setInstructions(undefined);
		this._tools = [];
		this._setStatus('error', failure);
		await this._closeResources();
	}

	/** Transport 意外关闭：仅 ready 时降级为 error；connecting 由 connect 异常处理，stopping/error 忽略。 */
	private async _onTransportClosed(): Promise<void> {
		if (this._disposed || this._status !== 'ready') {
			return;
		}
		logger.error(`# [McpConnection] 连接意外关闭 serverId=${this._serverId} prevStatus=${this._status}`);
		// 先下线已发布工具/instructions，再进入 error，避免模型继续使用失效 Server 的工具
		this._publishTools([]);
		await this._fail({ category: 'connection_closed', message: 'MCP 连接已关闭', retryable: true });
	}

	/**
	 * 工具列表变化通知：仅 ready 时重新完整分页发现并原子替换。
	 *
	 * 重新发现失败 MUST NOT 发布半量列表：先下线旧工具（发布空列表）再进入 error，
	 * 确保模型既看不到半量新列表，也不会继续使用过期列表。
	 */
	private async _onToolsChanged(): Promise<void> {
		if (this._disposed || this._status !== 'ready' || !this._client) {
			return;
		}
		logger.log(`# [McpConnection] 收到工具列表变化通知，开始重新发现 serverId=${this._serverId}`);
		try {
			const tools = await this._discoverTools();
			this._publishTools(tools);
			logger.log(`# [McpConnection] 工具列表已原子替换 serverId=${this._serverId} tools=${tools.length}`);
		} catch (e) {
			const failure = classifyError(e, 'discovery');
			logger.error(`# [McpConnection] 重新发现失败 serverId=${this._serverId} category=${failure.category}`);
			// 先下线旧工具，避免模型继续看到过期列表，再进入 error
			this._publishTools([]);
			await this._fail(failure);
		}
	}

	/** 有界关闭 Transport Handle 与 Client。Handle 先关闭以允许远程 terminateSession 在 transport 中止前发出。 */
	private async _closeResources(): Promise<void> {
		const client = this._client;
		const handle = this._handle;
		this._client = undefined;
		this._handle = undefined;
		// Handle 先关闭：远程 stateful session 需在 transport 中止前发送 DELETE（terminateSession）
		try {
			if (handle) {
				await withTimeout(handle.close(), DISPOSE_CLOSE_TIMEOUT_MS);
			}
		} catch (e) {
			logger.error(`# [McpConnection] Transport 关闭失败 serverId=${this._serverId}: ${e instanceof Error ? e.message : String(e)}`);
		}
		// Client 后关闭：清理 pending 请求 handler 与 client 状态
		try {
			if (client) {
				await withTimeout(client.close(), DISPOSE_CLOSE_TIMEOUT_MS);
			}
		} catch (e) {
			logger.error(`# [McpConnection] Client 关闭失败 serverId=${this._serverId}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

// ── 纯函数辅助 ──

/** 把 SDK 列出的工具转为原始发现工具。 */
function toDiscoveredTool(tool: { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: unknown }): McpDiscoveredTool {
	return {
		nativeToolName: tool.name,
		description: tool.description ?? '',
		inputSchema: tool.inputSchema,
		annotations: extractAnnotations(tool.annotations),
	};
}

/** 从 SDK annotations 提取权限相关子集。 */
function extractAnnotations(annotations: unknown): McpToolAnnotations | undefined {
	if (!annotations || typeof annotations !== 'object') {
		return undefined;
	}
	const a = annotations as { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown };
	const result: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } = {};
	let has = false;
	if (typeof a.readOnlyHint === 'boolean') { result.readOnlyHint = a.readOnlyHint; has = true; }
	if (typeof a.destructiveHint === 'boolean') { result.destructiveHint = a.destructiveHint; has = true; }
	if (typeof a.openWorldHint === 'boolean') { result.openWorldHint = a.openWorldHint; has = true; }
	return has ? result : undefined;
}

/**
 * 把 SDK/系统错误分类为结构化 MCP 失败。
 *
 * @param err 原始错误
 * @param fallback 默认类别（调用方已知上下文时使用）
 * @returns 结构化失败（不含秘密）
 */
export function classifyError(err: unknown, fallback?: McpFailure['category']): McpFailure {
	if (err instanceof McpError) {
		if (err.code === ErrorCode.RequestTimeout) {
			return { category: 'timeout', message: 'MCP 请求超时', retryable: true };
		}
		if (err.code === ErrorCode.ConnectionClosed) {
			return { category: 'connection_closed', message: 'MCP 连接已关闭', retryable: true };
		}
	}
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();
	if (lower.includes('protocol version') || lower.includes('protocol version is not supported')) {
		return { category: 'protocol', message: 'MCP 协议版本不兼容', retryable: false };
	}
	if (lower.includes('enoent') || lower.includes('spawn') || (err as { code?: string })?.code === 'ENOENT') {
		return { category: 'spawn', message: 'MCP 子进程启动失败', retryable: false };
	}
	return { category: fallback ?? 'unknown', message, retryable: false };
}

/**
 * 分类握手阶段错误：握手期间连接关闭通常意味着子进程启动失败
 * （command 不存在/立即退出，Windows 下 cross-spawn 表现为 close 而非 ENOENT），
 * 归一为 spawn 类别，便于设置页给出可诊断摘要。
 *
 * @param err 握手阶段抛出的错误
 * @returns 结构化失败
 */
function classifyConnectError(err: unknown): McpFailure {
	const failure = classifyError(err);
	if (failure.category === 'connection_closed') {
		return { category: 'spawn', message: 'MCP 子进程启动失败', retryable: false };
	}
	return failure;
}

/**
 * 判断 Streamable HTTP 连接错误是否属于兼容性失败（Server 不支持 Streamable HTTP）。
 *
 * 仅当错误为 StreamableHTTPError 且 HTTP 状态码为 404（Not Found）或 405
 * （Method Not Allowed）时返回 true——这表示 Server 端没有 Streamable HTTP
 * 端点，可以安全回退到 legacy SSE。401/403/5xx/超时/DNS 等不属于兼容性
 * 失败，不应触发回退。
 *
 * @param err 连接阶段抛出的错误
 * @returns true=可回退 legacy SSE；false=不可回退
 */
function isCompatFail(err: unknown): boolean {
	if (err instanceof StreamableHTTPError) {
		return err.code === 404 || err.code === 405;
	}
	return false;
}

/** 给 Promise 套一个有界超时，超时后resolve（不 reject），避免 dispose 卡死。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | void> {
	return new Promise<T | void>((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (!done) { done = true; resolve(undefined); }
		}, timeoutMs);
		promise.then((v) => {
			if (!done) { done = true; clearTimeout(timer); resolve(v); }
		}, () => {
			if (!done) { done = true; clearTimeout(timer); resolve(undefined); }
		});
	});
}
