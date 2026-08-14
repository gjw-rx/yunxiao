/**
 * MCP 配置 JSON 解析、字段归一化与事务计划（纯函数模块）。
 *
 * 职责：
 * - `parseMcpServersJson`：严格解析 `{ mcpServers }` JSON，校验顶层结构、
 *   Transport 判别联合与未知字段，返回带精确 `fieldPath` 的错误，不使用不受控
 *   类型断言接受 Webview 数据（任务 2.2）。
 * - `normalizeStdioConfig`/`normalizeHttpConfig`：把通过解析的输入归一化为
 *   非敏感持久化配置（env 值→envKeys、header 值→headerNames），STDIO cwd 经
 *   pathGuard 解析到当前主工作区（任务 2.4/2.6）。
 * - `planAddImport`/`planEdit`：纯函数事务计划，校验失败不产生部分变更
 *   （任务 2.8）。
 *
 * 安全：本模块不接触 SecretStorage，不保留任何 env/header 明文值；只产出
 * key/name 列表。秘密占位语义由 McpConfigStore 处理。
 */
import * as path from 'path';
import { resolveWithinRoots } from '../tools/fs/pathGuard';
import { PathGuardError } from '../core/errors';
import type {
	StdioMcpConfig,
	StdioMcpConfigInput,
	StreamableHttpMcpConfig,
	StreamableHttpMcpConfigInput,
	McpServerConfig,
	McpServerConfigInput,
} from './types';

/** 连接/初始化超时默认值（毫秒）。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** 单次 tools/call 超时默认值（毫秒）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** 超时下限（毫秒），低于此值视为非法。 */
const MIN_TIMEOUT_MS = 1_000;
/** 超时上限（毫秒），防止误填超大值。 */
const MAX_TIMEOUT_MS = 600_000;

/** STDIO Server 允许的字段。 */
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd', 'enabled', 'connectTimeoutMs', 'callTimeoutMs']);
/** Streamable HTTP Server 允许的字段。 */
const HTTP_FIELDS = new Set(['type', 'url', 'headers', 'legacySseFallback', 'enabled', 'connectTimeoutMs', 'callTimeoutMs']);

// ── 错误与结果类型 ──

/** 带精确字段路径的配置错误。 */
export interface McpConfigFieldError {
	/** 字段路径，如 `mcpServers.codegraph.type`、`mcpServers` 或 `mcpServers.<id>`。 */
	readonly fieldPath: string;
	readonly message: string;
}

/** JSON 解析结果。 */
export interface McpConfigParseResult {
	readonly ok: boolean;
	readonly errors: readonly McpConfigFieldError[];
	/** 通过校验的 Server 输入映射（ok=true 时有效）。 */
	readonly servers: Readonly<Record<string, McpServerConfigInput>>;
}

/** 单 Server 归一化结果。 */
export interface McpConfigNormalizeResult {
	readonly ok: boolean;
	readonly errors: readonly McpConfigFieldError[];
	/** 归一化后的非敏感配置（ok=true 时有效）。 */
	readonly config?: McpServerConfig;
}

/** 事务计划结果。 */
export interface McpConfigPlanResult {
	readonly ok: boolean;
	readonly errors: readonly McpConfigFieldError[];
	/** 应用事务后的完整 Server 映射（ok=true 时有效）。 */
	readonly servers: Readonly<Record<string, McpServerConfig>>;
}

/** 构造单条错误。 */
function err(fieldPath: string, message: string): McpConfigFieldError {
	return { fieldPath, message };
}

// ── 2.2: JSON 解析 ──

/**
 * 严格解析 MCP 配置 JSON 文本。
 *
 * @param text Webview 提交的原始 JSON 文本
 * @returns 解析结果；ok=false 时 errors 含可定位字段路径
 */
export function parseMcpServersJson(text: string): McpConfigParseResult {
	const errors: McpConfigFieldError[] = [];

	if (typeof text !== 'string' || text.trim().length === 0) {
		return { ok: false, errors: [err('mcpServers', 'MCP 配置不能为空')], servers: {} };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { ok: false, errors: [err('mcpServers', `JSON 语法错误: ${e instanceof Error ? e.message : String(e)}`)], servers: {} };
	}

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, errors: [err('mcpServers', '顶层结构必须为对象，且包含 mcpServers 字段')], servers: {} };
	}

	const top = parsed as Record<string, unknown>;
	const unknownTop = Object.keys(top).filter((k) => k !== 'mcpServers');
	if (unknownTop.length > 0) {
		errors.push(err(unknownTop[0], `顶层存在未知字段: ${unknownTop[0]}（仅允许 mcpServers）`));
		return { ok: false, errors, servers: {} };
	}

	const serversRaw = top.mcpServers;
	if (serversRaw === undefined || serversRaw === null) {
		return { ok: false, errors: [err('mcpServers', '缺少 mcpServers 字段')], servers: {} };
	}
	if (typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
		return { ok: false, errors: [err('mcpServers', 'mcpServers 必须为对象')], servers: {} };
	}

	const serversObj = serversRaw as Record<string, unknown>;
	const servers: Record<string, McpServerConfigInput> = {};

	for (const [id, raw] of Object.entries(serversObj)) {
		const idPath = `mcpServers.${id}`;
		if (typeof id !== 'string' || id.length === 0) {
			errors.push(err('mcpServers', 'Server ID 不能为空'));
			continue;
		}
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			errors.push(err(idPath, 'Server 配置必须为对象'));
			continue;
		}
		const server = raw as Record<string, unknown>;
		const typeVal = server.type;
		if (typeof typeVal !== 'string') {
			errors.push(err(`${idPath}.type`, 'type 字段缺失或非字符串'));
			continue;
		}
		// 兼容下划线写法 streamable_http（部分 MCP 客户端/文档使用），统一归一化为连字符
		const normalizedType = typeVal === 'streamable_http' ? 'streamable-http' : typeVal;
		if (normalizedType !== 'stdio' && normalizedType !== 'streamable-http') {
			errors.push(err(`${idPath}.type`, `未知的 Transport 类型: ${typeVal}（仅支持 stdio / streamable-http / streamable_http）`));
			continue;
		}

		// 未知字段检测
		const allowed = normalizedType === 'stdio' ? STDIO_FIELDS : HTTP_FIELDS;
		for (const field of Object.keys(server)) {
			if (!allowed.has(field)) {
				errors.push(err(`${idPath}.${field}`, `未知字段: ${field}`));
			}
		}

		// 结构与类型校验（必填字段缺失/类型不符产出精确 fieldPath）
		if (normalizedType === 'stdio') {
			const parsedStdio = parseStdioFields(idPath, server, errors);
			if (parsedStdio) {
				servers[id] = parsedStdio;
			}
		} else {
			const parsedHttp = parseHttpFields(idPath, server, errors);
			if (parsedHttp) {
				servers[id] = parsedHttp;
			}
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors, servers: {} };
	}
	return { ok: true, errors: [], servers };
}

/** 校验 STDIO 字段类型并构造输入对象；必填字段缺失或类型不符产出精确错误。 */
function parseStdioFields(idPath: string, server: Record<string, unknown>, errors: McpConfigFieldError[]): StdioMcpConfigInput | null {
	// command：必填字符串
	if (server.command === undefined) {
		errors.push(err(`${idPath}.command`, 'command 字段缺失'));
		return null;
	}
	if (typeof server.command !== 'string') {
		errors.push(err(`${idPath}.command`, 'command 必须为字符串'));
		return null;
	}
	// args：可选字符串数组
	let args: readonly string[] | undefined;
	if (server.args !== undefined) {
		if (!Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string')) {
			errors.push(err(`${idPath}.args`, 'args 必须为字符串数组'));
			return null;
		}
		args = server.args as readonly string[];
	}
	// env：可选 Record<string,string>
	let env: Readonly<Record<string, string>> | undefined;
	if (server.env !== undefined) {
		if (typeof server.env !== 'object' || server.env === null || Array.isArray(server.env)) {
			errors.push(err(`${idPath}.env`, 'env 必须为对象'));
			return null;
		}
		for (const v of Object.values(server.env)) {
			if (typeof v !== 'string') {
				errors.push(err(`${idPath}.env`, 'env 的每个值必须为字符串'));
				return null;
			}
		}
		env = server.env as Readonly<Record<string, string>>;
	}
	// cwd：可选字符串
	let cwd: string | undefined;
	if (server.cwd !== undefined) {
		if (typeof server.cwd !== 'string') {
			errors.push(err(`${idPath}.cwd`, 'cwd 必须为字符串'));
			return null;
		}
		cwd = server.cwd;
	}
	// enabled：可选布尔
	let enabled: boolean | undefined;
	if (server.enabled !== undefined) {
		if (typeof server.enabled !== 'boolean') {
			errors.push(err(`${idPath}.enabled`, 'enabled 必须为布尔值'));
			return null;
		}
		enabled = server.enabled;
	}
	// 超时：可选数字
	let connectTimeoutMs: number | undefined;
	if (server.connectTimeoutMs !== undefined) {
		if (typeof server.connectTimeoutMs !== 'number') {
			errors.push(err(`${idPath}.connectTimeoutMs`, 'connectTimeoutMs 必须为数字'));
			return null;
		}
		connectTimeoutMs = server.connectTimeoutMs;
	}
	let callTimeoutMs: number | undefined;
	if (server.callTimeoutMs !== undefined) {
		if (typeof server.callTimeoutMs !== 'number') {
			errors.push(err(`${idPath}.callTimeoutMs`, 'callTimeoutMs 必须为数字'));
			return null;
		}
		callTimeoutMs = server.callTimeoutMs;
	}
	return {
		type: 'stdio',
		command: server.command,
		...(args !== undefined ? { args } : {}),
		...(env !== undefined ? { env } : {}),
		...(cwd !== undefined ? { cwd } : {}),
		...(enabled !== undefined ? { enabled } : {}),
		...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
		...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
	};
}

/** 校验 Streamable HTTP 字段类型并构造输入对象；必填字段缺失或类型不符产出精确错误。 */
function parseHttpFields(idPath: string, server: Record<string, unknown>, errors: McpConfigFieldError[]): StreamableHttpMcpConfigInput | null {
	// url：必填字符串
	if (server.url === undefined) {
		errors.push(err(`${idPath}.url`, 'url 字段缺失'));
		return null;
	}
	if (typeof server.url !== 'string') {
		errors.push(err(`${idPath}.url`, 'url 必须为字符串'));
		return null;
	}
	// headers：可选 Record<string,string>
	let headers: Readonly<Record<string, string>> | undefined;
	if (server.headers !== undefined) {
		if (typeof server.headers !== 'object' || server.headers === null || Array.isArray(server.headers)) {
			errors.push(err(`${idPath}.headers`, 'headers 必须为对象'));
			return null;
		}
		for (const v of Object.values(server.headers)) {
			if (typeof v !== 'string') {
				errors.push(err(`${idPath}.headers`, 'headers 的每个值必须为字符串'));
				return null;
			}
		}
		headers = server.headers as Readonly<Record<string, string>>;
	}
	// legacySseFallback：可选布尔
	let legacySseFallback: boolean | undefined;
	if (server.legacySseFallback !== undefined) {
		if (typeof server.legacySseFallback !== 'boolean') {
			errors.push(err(`${idPath}.legacySseFallback`, 'legacySseFallback 必须为布尔值'));
			return null;
		}
		legacySseFallback = server.legacySseFallback;
	}
	// enabled：可选布尔
	let enabled: boolean | undefined;
	if (server.enabled !== undefined) {
		if (typeof server.enabled !== 'boolean') {
			errors.push(err(`${idPath}.enabled`, 'enabled 必须为布尔值'));
			return null;
		}
		enabled = server.enabled;
	}
	// 超时：可选数字
	let connectTimeoutMs: number | undefined;
	if (server.connectTimeoutMs !== undefined) {
		if (typeof server.connectTimeoutMs !== 'number') {
			errors.push(err(`${idPath}.connectTimeoutMs`, 'connectTimeoutMs 必须为数字'));
			return null;
		}
		connectTimeoutMs = server.connectTimeoutMs;
	}
	let callTimeoutMs: number | undefined;
	if (server.callTimeoutMs !== undefined) {
		if (typeof server.callTimeoutMs !== 'number') {
			errors.push(err(`${idPath}.callTimeoutMs`, 'callTimeoutMs 必须为数字'));
			return null;
		}
		callTimeoutMs = server.callTimeoutMs;
	}
	return {
		type: 'streamable-http',
		url: server.url,
		...(headers !== undefined ? { headers } : {}),
		...(legacySseFallback !== undefined ? { legacySseFallback } : {}),
		...(enabled !== undefined ? { enabled } : {}),
		...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
		...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
	};
}

// ── 2.4 / 2.6: 归一化 ──

/** 校验超时值并返回归一化结果（非法返回 null）。 */
function normalizeTimeout(value: number | undefined, fieldPath: string, errors: McpConfigFieldError[], defaultValue: number, label: string): number {
	if (value === undefined) {
		return defaultValue;
	}
	if (!Number.isFinite(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
		errors.push(err(fieldPath, `${label}需在 ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} 毫秒之间`));
		return defaultValue;
	}
	return Math.floor(value);
}

/**
 * 归一化 STDIO 配置：校验 command 非空、args/env 类型，cwd 经 pathGuard 解析到
 * 当前主工作区，env 值剥离为 key 列表，应用超时默认值。
 *
 * @param id Server ID（用于错误路径）
 * @param input 通过解析的 STDIO 输入
 * @param workspaceRoots 当前工作区根列表（cwd 解析基准）
 * @returns 归一化结果
 */
export async function normalizeStdioConfig(
	id: string,
	input: StdioMcpConfigInput,
	workspaceRoots: readonly string[]
): Promise<McpConfigNormalizeResult> {
	const errors: McpConfigFieldError[] = [];
	const idPath = `mcpServers.${id}`;

	const command = input.command?.trim() ?? '';
	if (command.length === 0) {
		errors.push(err(`${idPath}.command`, 'command 不能为空'));
	}

	const args = input.args ? [...input.args] : [];
	const envKeys = input.env ? Object.keys(input.env) : [];

	// cwd 解析：缺省为首个工作区根；显式路径经 pathGuard 校验越界
	let cwd: string | undefined;
	if (input.cwd !== undefined && input.cwd.trim().length > 0) {
		try {
			const resolved = await resolveWithinRoots(input.cwd, [...workspaceRoots]);
			cwd = resolved.fsPath;
		} catch (e) {
			if (e instanceof PathGuardError) {
				errors.push(err(`${idPath}.cwd`, `cwd 越界或不可用: ${e.message}`));
			} else {
				errors.push(err(`${idPath}.cwd`, `cwd 解析失败: ${e instanceof Error ? e.message : String(e)}`));
			}
		}
	} else if (workspaceRoots.length > 0) {
		cwd = path.resolve(workspaceRoots[0]);
	}

	const connectTimeoutMs = normalizeTimeout(input.connectTimeoutMs, `${idPath}.connectTimeoutMs`, errors, DEFAULT_CONNECT_TIMEOUT_MS, '连接超时');
	const callTimeoutMs = normalizeTimeout(input.callTimeoutMs, `${idPath}.callTimeoutMs`, errors, DEFAULT_CALL_TIMEOUT_MS, '调用超时');

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const config: StdioMcpConfig = {
		type: 'stdio',
		command,
		args,
		envKeys,
		...(cwd !== undefined ? { cwd } : {}),
		enabled: input.enabled ?? true,
		connectTimeoutMs,
		callTimeoutMs,
	};
	return { ok: true, errors: [], config };
}

/** 判断 hostname 是否为 loopback 地址。 */
function isLoopbackHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	return h === 'localhost' || h === '::1' || h === '127.0.0.1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * 归一化 Streamable HTTP 配置：校验 URL（HTTPS 或 loopback HTTP，禁止 userinfo），
 * header 值剥离为 name 列表，应用 legacySseFallback/超时默认值。
 *
 * @param id Server ID（用于错误路径）
 * @param input 通过解析的远程输入
 * @returns 归一化结果
 */
export function normalizeHttpConfig(id: string, input: StreamableHttpMcpConfigInput): McpConfigNormalizeResult {
	const errors: McpConfigFieldError[] = [];
	const idPath = `mcpServers.${id}`;

	const urlStr = input.url?.trim() ?? '';
	if (urlStr.length === 0) {
		errors.push(err(`${idPath}.url`, 'url 不能为空'));
		return { ok: false, errors };
	}

	let url: URL;
	try {
		url = new URL(urlStr);
	} catch {
		errors.push(err(`${idPath}.url`, 'url 格式不合法'));
		return { ok: false, errors };
	}

	if (url.username || url.password) {
		errors.push(err(`${idPath}.url`, 'url 不得包含用户信息（userinfo），请使用 headers 配置认证'));
	}
	if (url.protocol === 'https:') {
		// 安全
	} else if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
		// loopback 明文 HTTP 允许
	} else if (url.protocol === 'http:') {
		errors.push(err(`${idPath}.url`, '远程 url 必须为 HTTPS；仅 loopback 地址允许 HTTP'));
	} else {
		errors.push(err(`${idPath}.url`, `不支持的协议: ${url.protocol}（仅支持 http/https）`));
	}

	const headerNames = input.headers ? Object.keys(input.headers) : [];
	const connectTimeoutMs = normalizeTimeout(input.connectTimeoutMs, `${idPath}.connectTimeoutMs`, errors, DEFAULT_CONNECT_TIMEOUT_MS, '连接超时');
	const callTimeoutMs = normalizeTimeout(input.callTimeoutMs, `${idPath}.callTimeoutMs`, errors, DEFAULT_CALL_TIMEOUT_MS, '调用超时');

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const config: StreamableHttpMcpConfig = {
		type: 'streamable-http',
		url: urlStr,
		headerNames,
		legacySseFallback: input.legacySseFallback ?? false,
		enabled: input.enabled ?? true,
		connectTimeoutMs,
		callTimeoutMs,
	};
	return { ok: true, errors: [], config };
}

/**
 * 按 type 分派归一化。
 *
 * @param id Server ID
 * @param input 通过解析的输入配置
 * @param workspaceRoots 当前工作区根列表
 * @returns 归一化结果
 */
export async function normalizeServerConfig(
	id: string,
	input: McpServerConfigInput,
	workspaceRoots: readonly string[]
): Promise<McpConfigNormalizeResult> {
	if (input.type === 'stdio') {
		return normalizeStdioConfig(id, input, workspaceRoots);
	}
	return normalizeHttpConfig(id, input);
}

// ── 2.8: 事务计划 ──

/**
 * 规划新增/批量导入事务：incoming 中任一 ID 与 existing 冲突则整体失败，
 * 不产生部分变更。
 *
 * @param existing 当前持久化的 Server 映射
 * @param incoming 待新增的归一化 Server 映射
 * @returns 事务结果；ok=true 时 servers 为合并后的完整映射
 */
export function planAddImport(
	existing: Readonly<Record<string, McpServerConfig>>,
	incoming: Readonly<Record<string, McpServerConfig>>
): McpConfigPlanResult {
	const errors: McpConfigFieldError[] = [];
	if (Object.keys(incoming).length === 0) {
		return { ok: false, errors: [err('mcpServers', '没有可新增的 Server')], servers: {} };
	}
	for (const id of Object.keys(incoming)) {
		if (Object.prototype.hasOwnProperty.call(existing, id)) {
			errors.push(err(`mcpServers.${id}`, `Server ID 已存在: ${id}（新增不得覆盖，请先删除或改用编辑）`));
		}
	}
	if (errors.length > 0) {
		return { ok: false, errors, servers: {} };
	}
	return { ok: true, errors: [], servers: { ...existing, ...incoming } };
}

/**
 * 规划编辑事务：incoming 必须为单个 Server 且 ID 等于 editingId（禁止隐式重命名）。
 *
 * @param existing 当前持久化的 Server 映射
 * @param editingId 待编辑的 Server ID
 * @param incoming 归一化后的单 Server 映射
 * @returns 事务结果；ok=true 时 servers 为替换后的完整映射
 */
export function planEdit(
	existing: Readonly<Record<string, McpServerConfig>>,
	editingId: string,
	incoming: Readonly<Record<string, McpServerConfig>>
): McpConfigPlanResult {
	const errors: McpConfigFieldError[] = [];
	const incomingIds = Object.keys(incoming);
	if (incomingIds.length !== 1) {
		return { ok: false, errors: [err('mcpServers', '编辑模式仅允许提交一个 Server')], servers: {} };
	}
	const incomingId = incomingIds[0];
	if (!Object.prototype.hasOwnProperty.call(existing, editingId)) {
		return { ok: false, errors: [err(`mcpServers.${editingId}`, `未找到要编辑的 Server: ${editingId}`)], servers: {} };
	}
	if (incomingId !== editingId) {
		return {
			ok: false,
			errors: [err(`mcpServers.${incomingId}`, `编辑不得隐式重命名（提交 ID=${incomingId}，编辑目标=${editingId}），请删除后新增`)],
			servers: {},
		};
	}
	return { ok: true, errors: [], servers: { ...existing, [editingId]: incoming[editingId] } };
}
