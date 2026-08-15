/**
 * MCP 私有配置存储与秘密管理（任务 3.1-3.10）。
 *
 * 职责：
 * - 持久化版本化、非敏感的 MCP 配置文档到用户级 `~/.yunForce/mcp/servers.json`，
 *   使用临时文件 + rename 原子写入，失败时保留旧有效文档（3.2）。
 * - 将 STDIO env 值与远程 header 值分离到 VS Code SecretStorage，key 由 Server ID、
 *   秘密类型与字段名稳定拼接；普通文件只保留 key/name 列表（3.4）。
 * - 编辑现有 Server 时以固定 `<已安全保存>` 占位替代明文，按保留/替换/删除语义
 *   处理秘密；新 Server 伪造占位或既有秘密缺失均拒绝（3.6）。
 * - 批量新增/编辑/启停/删除经串行写队列事务式执行，SecretStorage 或文件写失败时
 *   尽力回滚本次 Secret 变化且不发布新 revision（3.8）。
 * - 不读取、不写入工作区 `.mcp.json`；MCP 配置唯一来源为本私有存储。
 *
 * 安全：本模块绝不向 Webview/日志返回 env/header 明文；运行时配置（含秘密）仅
 * 供 Host 内 Manager 使用。日志只记录 Server ID 与 key 数量。
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as logger from '../logger';
import {
	parseMcpServersJson,
	normalizeStdioConfig,
	normalizeHttpConfig,
	planAddImport,
	planEdit,
	type McpConfigFieldError,
} from './configParser';
import type {
	McpConfigDocument,
	McpServerConfig,
	McpServerConfigInput,
	StdioMcpConfigInput,
	StreamableHttpMcpConfigInput,
	McpServerRuntimeConfig,
	McpServerConfigView,
	McpServerEditView,
} from './types';
import { MCP_SECRET_PLACEHOLDER } from './types';

/** SecretStorage key 前缀。 */
const SECRET_KEY_PREFIX = 'yunxiaoAgent.mcp.';
/** 配置文件相对全局 `.yunForce` 配置目录的路径。 */
const MCP_CONFIG_RELATIVE_PATH = path.join('mcp', 'servers.json');
/** 空文档初始 revision。 */
const INITIAL_REVISION = 0;

// ── 结果类型 ──

/** 保存（新增/编辑）事务结果。 */
export interface McpSaveResult {
	readonly ok: boolean;
	readonly errors: readonly McpConfigFieldError[];
	/** 成功时为新 revision；失败时为 undefined。 */
	readonly revision?: number;
	/** 成功时为应用事务后的完整 Server 映射；失败时为空对象。 */
	readonly servers: Readonly<Record<string, McpServerConfig>>;
}

/** 启停操作结果。 */
export interface McpEnabledResult {
	readonly ok: boolean;
	readonly error?: string;
	/** 成功时为新 revision。 */
	readonly revision?: number;
}

/** 删除操作结果。 */
export interface McpSimpleResult {
	readonly ok: boolean;
	readonly error?: string;
}

/** 编辑视图结果（单 Server JSON + 秘密占位）。 */
export interface McpEditViewResult {
	readonly ok: boolean;
	readonly editView?: McpServerEditView;
	readonly error?: string;
}

/** 设置页配置项（id + 非敏感配置视图，供 Host 合并运行时状态）。 */
export interface McpServerConfigEntry {
	readonly id: string;
	readonly config: McpServerConfigView;
}

// ── 文档 IO 抽象（便于测试注入失败）──

/** MCP 配置文档读写抽象。 */
export interface McpDocumentIO {
	/** 读取文档原文；文件不存在时返回 undefined。 */
	read(): Promise<string | undefined>;
	/** 原子写入文档原文（临时文件 + rename）。 */
	writeAtomic(content: string): Promise<void>;
}

/** 基于真实文件系统的文档 IO 实现。 */
class FsMcpDocumentIO implements McpDocumentIO {
	constructor(private readonly _filePath: string) { }

	async read(): Promise<string | undefined> {
		try {
			return await fs.readFile(this._filePath, 'utf8');
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw e;
		}
	}

	async writeAtomic(content: string): Promise<void> {
		const dir = path.dirname(this._filePath);
		await fs.mkdir(dir, { recursive: true });
		const tmp = `${this._filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			await fs.writeFile(tmp, content, 'utf8');
			await fs.rename(tmp, this._filePath);
		} catch (e) {
			try { await fs.unlink(tmp); } catch { /* 尽力清理临时文件 */ }
			throw e;
		}
	}
}

// ── 秘密操作记录 ──

/** 单条秘密写入操作（含回滚所需旧值）。 */
interface SecretStoreOp {
	readonly key: string;
	readonly value: string;
	/** 写入前读取的旧值；undefined 表示该 key 原本不存在（新增）。 */
	readonly oldValue: string | undefined;
}

// ── Store ──

/**
 * MCP 私有配置存储服务。
 *
 * 串行执行所有写操作，事务式协调非敏感文档与 SecretStorage，确保校验或写入失败
 * 时不产生部分变更、不发布新 revision。
 */
export class McpConfigStore {
	private readonly _filePath: string;
	private readonly _io: McpDocumentIO;
	/** 串行写队列：所有变更操作按到达顺序依次执行。 */
	private _writeChain: Promise<unknown> = Promise.resolve();

	/**
	 * 创建存储服务。
	 *
	 * @param context VS Code 扩展上下文（用于 SecretStorage）
	 * @param globalConfigRoot 全局 `.yunForce` 配置目录；缺省时使用用户主目录下 `.yunForce`
	 * @param workspaceRoots 当前工作区根列表（STDIO cwd 归一化基准）
	 * @param io 文档读写抽象；缺省时使用真实文件系统实现
	 */
	constructor(
		private readonly context: vscode.ExtensionContext,
		globalConfigRoot: string = path.join(os.homedir(), '.yunForce'),
		private readonly workspaceRoots: readonly string[] = [],
		io?: McpDocumentIO
	) {
		this._filePath = path.join(globalConfigRoot, MCP_CONFIG_RELATIVE_PATH);
		this._io = io ?? new FsMcpDocumentIO(this._filePath);
	}

	/**
	 * 读取当前持久化文档。
	 *
	 * @returns 版本化 MCP 配置文档；无文件时返回空文档（revision=0）
	 */
	async getDocument(): Promise<McpConfigDocument> {
		return this._readDocument();
	}

	/**
	 * 获取设置页配置视图（非敏感，供 Host 合并运行时状态）。
	 *
	 * @returns Server ID + 非敏感配置视图列表
	 */
	async getSettingsView(): Promise<readonly McpServerConfigEntry[]> {
		const doc = await this._readDocument();
		return Object.entries(doc.servers).map(([id, config]) => ({ id, config: toConfigView(config) }));
	}

	/**
	 * 获取单 Server 编辑视图（env/header 值替换为占位）。
	 *
	 * @param serverId 待编辑的 Server ID
	 * @returns 编辑视图结果
	 */
	async getEditView(serverId: string): Promise<McpEditViewResult> {
		const doc = await this._readDocument();
		const config = doc.servers[serverId];
		if (!config) {
			return { ok: false, error: `未找到 Server: ${serverId}` };
		}
		return { ok: true, editView: toEditView(config) };
	}

	/**
	 * 获取单 Server 运行时配置（装配 SecretStorage 秘密值，仅 Host 使用）。
	 *
	 * @param serverId Server ID
	 * @returns 运行时配置；不存在时为 undefined
	 */
	async getRuntimeConfig(serverId: string): Promise<McpServerRuntimeConfig | undefined> {
		const doc = await this._readDocument();
		const config = doc.servers[serverId];
		if (!config) {
			return undefined;
		}
		return this._assembleRuntime(serverId, config);
	}

	/**
	 * 新增/批量导入 Server。任一 ID 与既有冲突则整体失败，不产生部分变更。
	 *
	 * @param jsonText Webview 提交的 `{ mcpServers }` JSON 文本
	 * @returns 事务结果
	 */
	saveAddImport(jsonText: string): Promise<McpSaveResult> {
		return this._serialize(() => this._doSaveAddImport(jsonText));
	}

	/**
	 * 编辑单个 Server。提交 ID 必须等于 editingServerId，禁止隐式重命名。
	 *
	 * @param editingServerId 待编辑的 Server ID
	 * @param jsonText 单 Server `{ mcpServers }` JSON 文本
	 * @returns 事务结果
	 */
	saveEdit(editingServerId: string, jsonText: string): Promise<McpSaveResult> {
		return this._serialize(() => this._doSaveEdit(editingServerId, jsonText));
	}

	/**
	 * 启用或停用 Server（持久化 enabled，递增 revision）。
	 *
	 * @param serverId Server ID
	 * @param enabled 是否启用
	 * @returns 操作结果
	 */
	setEnabled(serverId: string, enabled: boolean): Promise<McpEnabledResult> {
		return this._serialize(() => this._doSetEnabled(serverId, enabled));
	}

	/**
	 * 删除 Server：移除非敏感配置并清理全部关联 Secrets。
	 *
	 * @param serverId Server ID
	 * @returns 操作结果
	 */
	delete(serverId: string): Promise<McpSimpleResult> {
		return this._serialize(() => this._doDelete(serverId));
	}

	// ── 内部实现 ──

	/** 串行化变更操作：按到达顺序依次执行，互不并发。 */
	private _serialize<T>(fn: () => Promise<T>): Promise<T> {
		const next = this._writeChain.then(fn, fn);
		this._writeChain = next.then(() => undefined, () => undefined);
		return next;
	}

	/** 读取并校验文档；文件不存在或损坏时返回空文档。 */
	private async _readDocument(): Promise<McpConfigDocument> {
		const raw = await this._io.read();
		if (!raw) {
			return { version: 1, revision: INITIAL_REVISION, servers: {} };
		}
		try {
			const parsed = JSON.parse(raw) as McpConfigDocument;
			if (parsed.version !== 1 || typeof parsed.revision !== 'number' || typeof parsed.servers !== 'object' || !parsed.servers) {
				logger.error(`[McpConfigStore] 文档格式不受支持，回退空文档 path=${this._filePath}`);
				return { version: 1, revision: INITIAL_REVISION, servers: {} };
			}
			return { version: 1, revision: parsed.revision, servers: parsed.servers };
		} catch (e) {
			logger.error(`[McpConfigStore] 读取文档失败 path=${this._filePath}: ${e instanceof Error ? e.message : String(e)}`);
			return { version: 1, revision: INITIAL_REVISION, servers: {} };
		}
	}

	/** 原子写入文档。 */
	private async _writeDocument(doc: McpConfigDocument): Promise<void> {
		await this._io.writeAtomic(`${JSON.stringify(doc, null, 2)}\n`);
	}

	/** 新增/批量导入实现。 */
	private async _doSaveAddImport(jsonText: string): Promise<McpSaveResult> {
		const empty: McpSaveResult = { ok: false, errors: [], servers: {} };
		const parsed = parseMcpServersJson(jsonText);
		if (!parsed.ok) {
			return { ...empty, errors: parsed.errors };
		}

		const doc = await this._readDocument();
		const errors: McpConfigFieldError[] = [];
		const normalized: Record<string, McpServerConfig> = {};
		const storeOpsByServer = new Map<string, SecretStoreOp[]>();
		const deleteOpsByServer = new Map<string, string[]>();

		for (const [id, input] of Object.entries(parsed.servers)) {
			// 新增模式：不存在既有配置，占位一律拒绝
			const resolved = await this._resolveSecretOps(id, input, undefined);
			if (resolved.errors.length > 0) {
				errors.push(...resolved.errors);
				continue;
			}
			const normResult = await normalizeServerConfig(id, resolved.cleanedInput, this.workspaceRoots);
			if (!normResult.ok || !normResult.config) {
				errors.push(...normResult.errors);
				continue;
			}
			normalized[id] = normResult.config;
			storeOpsByServer.set(id, resolved.storeOps);
			deleteOpsByServer.set(id, resolved.deleteOps);
		}
		if (errors.length > 0) {
			return { ...empty, errors };
		}

		const plan = planAddImport(doc.servers, normalized);
		if (!plan.ok) {
			return { ...empty, errors: plan.errors };
		}

		return this._executeTransaction(doc.revision, plan.servers, storeOpsByServer, deleteOpsByServer);
	}

	/** 编辑单 Server 实现。 */
	private async _doSaveEdit(editingServerId: string, jsonText: string): Promise<McpSaveResult> {
		const empty: McpSaveResult = { ok: false, errors: [], servers: {} };
		const parsed = parseMcpServersJson(jsonText);
		if (!parsed.ok) {
			return { ...empty, errors: parsed.errors };
		}

		const doc = await this._readDocument();
		const existingConfig = doc.servers[editingServerId];
		if (!existingConfig) {
			return { ...empty, errors: [{ fieldPath: `mcpServers.${editingServerId}`, message: `未找到要编辑的 Server: ${editingServerId}` }] };
		}

		const errors: McpConfigFieldError[] = [];
		const normalized: Record<string, McpServerConfig> = {};
		const storeOpsByServer = new Map<string, SecretStoreOp[]>();
		const deleteOpsByServer = new Map<string, string[]>();

		for (const [id, input] of Object.entries(parsed.servers)) {
			const resolved = await this._resolveSecretOps(id, input, existingConfig);
			if (resolved.errors.length > 0) {
				errors.push(...resolved.errors);
				continue;
			}
			const normResult = await normalizeServerConfig(id, resolved.cleanedInput, this.workspaceRoots);
			if (!normResult.ok || !normResult.config) {
				errors.push(...normResult.errors);
				continue;
			}
			normalized[id] = normResult.config;
			storeOpsByServer.set(id, resolved.storeOps);
			deleteOpsByServer.set(id, resolved.deleteOps);
		}
		if (errors.length > 0) {
			return { ...empty, errors };
		}

		const plan = planEdit(doc.servers, editingServerId, normalized);
		if (!plan.ok) {
			return { ...empty, errors: plan.errors };
		}

		return this._executeTransaction(doc.revision, plan.servers, storeOpsByServer, deleteOpsByServer);
	}

	/** 启停实现。 */
	private async _doSetEnabled(serverId: string, enabled: boolean): Promise<McpEnabledResult> {
		const doc = await this._readDocument();
		const config = doc.servers[serverId];
		if (!config) {
			return { ok: false, error: `未找到 Server: ${serverId}` };
		}
		const newServers = { ...doc.servers, [serverId]: { ...config, enabled } };
		const newRevision = doc.revision + 1;
		try {
			await this._writeDocument({ version: 1, revision: newRevision, servers: newServers });
		} catch (e) {
			logger.error(`[McpConfigStore] 启停写入失败 serverId=${serverId} enabled=${enabled}: ${e instanceof Error ? e.message : String(e)}`);
			return { ok: false, error: '配置文件写入失败' };
		}
		logger.log(`[McpConfigStore] 启停已保存 serverId=${serverId} enabled=${enabled} revision=${newRevision}`);
		return { ok: true, revision: newRevision };
	}

	/** 删除实现：先写文档（移除 Server），再清理 Secrets。 */
	private async _doDelete(serverId: string): Promise<McpSimpleResult> {
		const doc = await this._readDocument();
		const config = doc.servers[serverId];
		if (!config) {
			return { ok: false, error: `未找到 Server: ${serverId}` };
		}
		const newServers = { ...doc.servers };
		delete newServers[serverId];
		const newRevision = doc.revision + 1;
		try {
			await this._writeDocument({ version: 1, revision: newRevision, servers: newServers });
		} catch (e) {
			logger.error(`[McpConfigStore] 删除写入失败 serverId=${serverId}: ${e instanceof Error ? e.message : String(e)}`);
			return { ok: false, error: '配置文件写入失败' };
		}
		// 尽力清理全部关联 Secrets
		await this._cleanupServerSecrets(serverId, config);
		logger.log(`[McpConfigStore] Server 已删除 serverId=${serverId} revision=${newRevision}`);
		return { ok: true };
	}

	/**
	 * 解析单 Server 输入的秘密操作：占位=保留、非空=写入、空值/移除=删除。
	 * 清洗后的输入（去除空值）供归一化使用。
	 *
	 * @param id Server ID
	 * @param input 解析后的用户输入
	 * @param existingConfig 既有归一化配置（编辑模式）；新增模式为 undefined
	 * @returns 清洗后输入、待写入秘密操作、待删除秘密 key 与错误
	 */
	private async _resolveSecretOps(
		id: string,
		input: McpServerConfigInput,
		existingConfig: McpServerConfig | undefined
	): Promise<{
		readonly cleanedInput: McpServerConfigInput;
		readonly storeOps: SecretStoreOp[];
		readonly deleteOps: string[];
		readonly errors: McpConfigFieldError[];
	}> {
		const errors: McpConfigFieldError[] = [];
		const storeOps: SecretStoreOp[] = [];
		const deleteOps: string[] = [];

		if (input.type === 'stdio') {
			const result = await this._resolveStdioSecrets(id, input, existingConfig, errors);
			storeOps.push(...result.storeOps);
			deleteOps.push(...result.deleteOps);
			const { env: _unusedEnv, ...restEnv } = input;
			void _unusedEnv;
			const cleanedInput: StdioMcpConfigInput = result.cleanedEnv
				? { ...input, env: result.cleanedEnv }
				: restEnv;
			return { cleanedInput, storeOps, deleteOps, errors };
		}
		const result = await this._resolveHttpSecrets(id, input, existingConfig, errors);
		storeOps.push(...result.storeOps);
		deleteOps.push(...result.deleteOps);
		const { headers: _unusedHeaders, ...restHeaders } = input;
		void _unusedHeaders;
		const cleanedInput: StreamableHttpMcpConfigInput = result.cleanedHeaders
			? { ...input, headers: result.cleanedHeaders }
			: restHeaders;
		return { cleanedInput, storeOps, deleteOps, errors };
	}

	/** 解析 STDIO env 秘密操作。 */
	private async _resolveStdioSecrets(
		id: string,
		input: StdioMcpConfigInput,
		existingConfig: McpServerConfig | undefined,
		errors: McpConfigFieldError[]
	): Promise<{ readonly storeOps: SecretStoreOp[]; readonly deleteOps: string[]; readonly cleanedEnv: Record<string, string> | undefined }> {
		const env = input.env ?? {};
		const existingKeys = existingConfig?.type === 'stdio' ? existingConfig.envKeys : [];
		const storeOps: SecretStoreOp[] = [];
		const deleteOps: string[] = [];
		const cleanedEnv: Record<string, string> = {};

		for (const [key, value] of Object.entries(env)) {
			if (value === '') {
				// 空值：跳过；若为既有 key 则删除秘密
				if (existingKeys.includes(key)) {
					deleteOps.push(secretKey(id, 'env', key));
				}
				continue;
			}
			cleanedEnv[key] = value;
			if (value === MCP_SECRET_PLACEHOLDER) {
				// 占位=保留：必须存在既有 key 且 SecretStorage 有值
				if (!existingConfig || !existingKeys.includes(key)) {
					errors.push({ fieldPath: `mcpServers.${id}.env.${key}`, message: `新配置不得使用秘密占位: ${key}` });
					continue;
				}
				const existing = await this.context.secrets.get(secretKey(id, 'env', key));
				if (existing === undefined) {
					errors.push({ fieldPath: `mcpServers.${id}.env.${key}`, message: `字段 ${key} 标记为保留但未找到已保存的秘密` });
				}
			} else {
				// 非空明文=写入/替换
				const sk = secretKey(id, 'env', key);
				const oldValue = await this.context.secrets.get(sk);
				storeOps.push({ key: sk, value, oldValue });
			}
		}
		// 既有 key 未出现在新输入 → 删除
		for (const key of existingKeys) {
			if (!(key in env)) {
				deleteOps.push(secretKey(id, 'env', key));
			}
		}
		return { storeOps, deleteOps, cleanedEnv: Object.keys(cleanedEnv).length > 0 ? cleanedEnv : undefined };
	}

	/** 解析远程 header 秘密操作。 */
	private async _resolveHttpSecrets(
		id: string,
		input: StreamableHttpMcpConfigInput,
		existingConfig: McpServerConfig | undefined,
		errors: McpConfigFieldError[]
	): Promise<{ readonly storeOps: SecretStoreOp[]; readonly deleteOps: string[]; readonly cleanedHeaders: Record<string, string> | undefined }> {
		const headers = input.headers ?? {};
		const existingNames = existingConfig?.type === 'streamable-http' ? existingConfig.headerNames : [];
		const storeOps: SecretStoreOp[] = [];
		const deleteOps: string[] = [];
		const cleanedHeaders: Record<string, string> = {};

		for (const [name, value] of Object.entries(headers)) {
			if (value === '') {
				if (existingNames.includes(name)) {
					deleteOps.push(secretKey(id, 'header', name));
				}
				continue;
			}
			cleanedHeaders[name] = value;
			if (value === MCP_SECRET_PLACEHOLDER) {
				if (!existingConfig || !existingNames.includes(name)) {
					errors.push({ fieldPath: `mcpServers.${id}.headers.${name}`, message: `新配置不得使用秘密占位: ${name}` });
					continue;
				}
				const existing = await this.context.secrets.get(secretKey(id, 'header', name));
				if (existing === undefined) {
					errors.push({ fieldPath: `mcpServers.${id}.headers.${name}`, message: `字段 ${name} 标记为保留但未找到已保存的秘密` });
				}
			} else {
				const sk = secretKey(id, 'header', name);
				const oldValue = await this.context.secrets.get(sk);
				storeOps.push({ key: sk, value, oldValue });
			}
		}
		for (const name of existingNames) {
			if (!(name in headers)) {
				deleteOps.push(secretKey(id, 'header', name));
			}
		}
		return { storeOps, deleteOps, cleanedHeaders: Object.keys(cleanedHeaders).length > 0 ? cleanedHeaders : undefined };
	}

	/**
	 * 执行事务：先写新秘密，再原子写文档，最后删除移除的秘密。
	 * 任一阶段失败回滚本次秘密变更且不发布 revision。
	 *
	 * @param oldRevision 当前文档 revision
	 * @param newServers 事务计划后的完整 Server 映射
	 * @param storeOpsByServer 各 Server 待写入秘密操作
	 * @param deleteOpsByServer 各 Server 待删除秘密 key
	 * @returns 事务结果
	 */
	private async _executeTransaction(
		oldRevision: number,
		newServers: Readonly<Record<string, McpServerConfig>>,
		storeOpsByServer: Map<string, SecretStoreOp[]>,
		deleteOpsByServer: Map<string, string[]>
	): Promise<McpSaveResult> {
		const allStoreOps: SecretStoreOp[] = [];
		for (const ops of storeOpsByServer.values()) {
			allStoreOps.push(...ops);
		}

		// 1. 写入新秘密，记录已写入以便回滚
		const written: SecretStoreOp[] = [];
		for (const op of allStoreOps) {
			try {
				await this.context.secrets.store(op.key, op.value);
				written.push(op);
			} catch (e) {
				logger.error(`[McpConfigStore] SecretStorage 写入失败 key=${op.key}: ${e instanceof Error ? e.message : String(e)}`);
				await this._rollbackSecrets(written);
				return { ok: false, errors: [{ fieldPath: 'mcpServers', message: 'SecretStorage 写入失败，已回滚' }], servers: {} };
			}
		}

		// 2. 原子写文档
		const newRevision = oldRevision + 1;
		try {
			await this._writeDocument({ version: 1, revision: newRevision, servers: newServers });
		} catch (e) {
			logger.error(`[McpConfigStore] 配置文件写入失败: ${e instanceof Error ? e.message : String(e)}`);
			await this._rollbackSecrets(written);
			return { ok: false, errors: [{ fieldPath: 'mcpServers', message: '配置文件写入失败，已回滚' }], servers: {} };
		}

		// 3. 删除移除的秘密（best-effort，文档已发布 revision）
		for (const keys of deleteOpsByServer.values()) {
			for (const key of keys) {
				try {
					await this.context.secrets.delete(key);
				} catch (e) {
					logger.error(`[McpConfigStore] SecretStorage 删除失败 key=${key}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}

		const keyCount = allStoreOps.length;
		logger.log(`[McpConfigStore] 配置已保存 revision=${newRevision} servers=${Object.keys(newServers).length} secretKeys=${keyCount}`);
		return { ok: true, errors: [], revision: newRevision, servers: newServers };
	}

	/** 回滚已写入的秘密：新增 key 删除，替换 key 恢复旧值。 */
	private async _rollbackSecrets(written: readonly SecretStoreOp[]): Promise<void> {
		for (const op of written) {
			try {
				if (op.oldValue === undefined) {
					await this.context.secrets.delete(op.key);
				} else {
					await this.context.secrets.store(op.key, op.oldValue);
				}
			} catch (e) {
				logger.error(`[McpConfigStore] 回滚秘密失败 key=${op.key}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	/** 清理 Server 全部关联秘密（删除时 best-effort）。 */
	private async _cleanupServerSecrets(serverId: string, config: McpServerConfig): Promise<void> {
		const keys: string[] = [];
		if (config.type === 'stdio') {
			for (const k of config.envKeys) {
				keys.push(secretKey(serverId, 'env', k));
			}
		} else {
			for (const n of config.headerNames) {
				keys.push(secretKey(serverId, 'header', n));
			}
		}
		for (const key of keys) {
			try {
				await this.context.secrets.delete(key);
			} catch (e) {
				logger.error(`[McpConfigStore] 清理秘密失败 key=${key}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	/** 装配运行时配置：从 SecretStorage 读取 env/header 值。 */
	private async _assembleRuntime(serverId: string, config: McpServerConfig): Promise<McpServerRuntimeConfig> {
		if (config.type === 'stdio') {
			const env: Record<string, string> = {};
			for (const key of config.envKeys) {
				env[key] = (await this.context.secrets.get(secretKey(serverId, 'env', key))) ?? '';
			}
			const { envKeys: _unused, ...rest } = config;
			void _unused;
			return { ...rest, env };
		}
		const headers: Record<string, string> = {};
		for (const name of config.headerNames) {
			headers[name] = (await this.context.secrets.get(secretKey(serverId, 'header', name))) ?? '';
		}
		const { headerNames: _unused, ...rest } = config;
		void _unused;
		return { ...rest, headers };
	}
}

// ── 纯函数辅助 ──

/** 构造 SecretStorage key。 */
function secretKey(serverId: string, kind: 'env' | 'header', fieldName: string): string {
	return `${SECRET_KEY_PREFIX}${serverId}.${kind}.${fieldName}`;
}

/** 按 type 分派归一化（封装 configParser.normalizeServerConfig）。 */
async function normalizeServerConfig(
	id: string,
	input: McpServerConfigInput,
	workspaceRoots: readonly string[]
): Promise<{ readonly ok: boolean; readonly errors: readonly McpConfigFieldError[]; readonly config?: McpServerConfig }> {
	if (input.type === 'stdio') {
		const r = await normalizeStdioConfig(id, input, workspaceRoots);
		return r;
	}
	return normalizeHttpConfig(id, input);
}

/** 归一化配置 → 非敏感配置视图。 */
function toConfigView(config: McpServerConfig): McpServerConfigView {
	if (config.type === 'stdio') {
		return {
			type: 'stdio',
			command: config.command,
			args: config.args,
			envKeys: config.envKeys,
			...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
			enabled: config.enabled,
			connectTimeoutMs: config.connectTimeoutMs,
			callTimeoutMs: config.callTimeoutMs,
		};
	}
	return {
		type: 'streamable-http',
		url: config.url,
		headerNames: config.headerNames,
		legacySseFallback: config.legacySseFallback,
		enabled: config.enabled,
		connectTimeoutMs: config.connectTimeoutMs,
		callTimeoutMs: config.callTimeoutMs,
	};
}

/** 归一化配置 → 编辑视图（env/header 值替换为占位）。 */
function toEditView(config: McpServerConfig): McpServerEditView {
	if (config.type === 'stdio') {
		const env: Record<string, string> = {};
		for (const key of config.envKeys) {
			env[key] = MCP_SECRET_PLACEHOLDER;
		}
		return {
			type: 'stdio',
			command: config.command,
			args: config.args,
			env,
			...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
			enabled: config.enabled,
			connectTimeoutMs: config.connectTimeoutMs,
			callTimeoutMs: config.callTimeoutMs,
		};
	}
	const headers: Record<string, string> = {};
	for (const name of config.headerNames) {
		headers[name] = MCP_SECRET_PLACEHOLDER;
	}
	return {
		type: 'streamable-http',
		url: config.url,
		headers,
		legacySseFallback: config.legacySseFallback,
		enabled: config.enabled,
		connectTimeoutMs: config.connectTimeoutMs,
		callTimeoutMs: config.callTimeoutMs,
	};
}
