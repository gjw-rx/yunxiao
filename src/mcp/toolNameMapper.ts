/**
 * MCP 工具名映射器 — 将 MCP 原始工具名映射为模型可见的 `mcp__<server>__<tool>` 暴露名。
 *
 * 职责：
 * - 净化 Server/工具名中的非法字符为下划线，保证符合 Function Calling 字符限制
 * - 超长名称使用稳定哈希后缀截断，确保同一输入始终产生同一输出
 * - 构建不可变反向 catalog（exposed name → 完整 catalog entry），执行时直接查找，禁止临时拆分
 * - 检测最终冲突（两个不同原始标识归一化后相同）并拒绝注册
 *
 * 安全约定：映射器不持有 Secret/Transport，仅做纯数据映射。
 */
import { createHash } from 'node:crypto';
import type { McpToolCatalogEntry, McpToolAnnotations } from './types';

/** Function Calling 工具名最大长度（OpenAI 限制 64）。 */
const MAX_EXPOSED_NAME_LENGTH = 64;

/** 暴露名前缀。 */
const MCP_PREFIX = 'mcp__';

/** 哈希后缀长度（hex 字符）。 */
const HASH_SUFFIX_LENGTH = 8;

/** Mapper 构造输入项（不含 exposedName，由 mapper 计算）。 */
export interface McpToolNameMapperInput {
	/** 所属 Server ID。 */
	readonly serverId: string;
	/** Server 端原始 MCP 工具名。 */
	readonly nativeToolName: string;
	readonly description: string;
	/** MCP inputSchema（原样复用，缺失时由调用方传空对象）。 */
	readonly inputSchema: Record<string, unknown>;
	readonly annotations?: McpToolAnnotations;
}

/**
 * 净化名称片段：非法字符替换为下划线， collapse 连续下划线，去除首尾下划线。
 * 合法字符：a-z A-Z 0-9 _
 * @param segment 待净化的名称片段
 * @returns 净化后的片段，可能为空字符串
 */
function sanitizeSegment(segment: string): string {
	return segment
		.replace(/[^a-zA-Z0-9_]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
}

/**
 * 计算字符串的稳定 hex 哈希前缀（SHA-256 前 N 位）。
 * @param value 待哈希的字符串
 * @param length hex 字符数
 * @returns 稳定 hex 哈希
 */
function stableHash(value: string, length: number): string {
	return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * 构建暴露名：`mcp__<server>__<tool>`，超长时截断并附加稳定哈希后缀。
 * @param server 净化后的 Server 片段
 * @param tool 净化后的工具片段
 * @returns 符合长度限制的暴露名
 */
function buildExposedName(server: string, tool: string): string {
	const fullName = `${MCP_PREFIX}${server}__${tool}`;
	if (fullName.length <= MAX_EXPOSED_NAME_LENGTH) {
		return fullName;
	}
	// 超长：截断并附加稳定哈希后缀 `__<hash8>`
	const hash = stableHash(fullName, HASH_SUFFIX_LENGTH);
	const suffix = `__${hash}`;
	const maxPrefix = MAX_EXPOSED_NAME_LENGTH - suffix.length;
	const truncated = fullName.slice(0, maxPrefix).replace(/_+$/, '');
	return `${truncated}${suffix}`;
}

/**
 * MCP 工具名映射器：构建不可变 catalog 并提供反向查找。
 *
 * 构造时完成所有净化、哈希和冲突检测；构造完成后 catalog 不可变，
 * 执行时通过 getByExposedName 直接查找目的地，禁止从 exposed name 临时拆分。
 */
export class McpToolNameMapper {
	/** 不可变 catalog（按注册顺序）。 */
	private readonly _catalog: readonly McpToolCatalogEntry[];
	/** exposed name → catalog entry 反向索引。 */
	private readonly _byExposedName: ReadonlyMap<string, McpToolCatalogEntry>;

	/**
	 * @param inputs 待映射的工具输入列表
	 * @throws 当 Server/工具名为空、净化后为空或暴露名冲突时抛错
	 */
	constructor(inputs: readonly McpToolNameMapperInput[]) {
		const catalog: McpToolCatalogEntry[] = [];
		const byExposedName = new Map<string, McpToolCatalogEntry>();

		for (const input of inputs) {
			const server = sanitizeSegment(input.serverId);
			if (!server) {
				throw new Error(`MCP 工具名映射失败：Server ID 净化后为空 — serverId="${input.serverId}"`);
			}
			const tool = sanitizeSegment(input.nativeToolName);
			if (!tool) {
				throw new Error(`MCP 工具名映射失败：工具名净化后为空 — serverId="${input.serverId}" nativeToolName="${input.nativeToolName}"`);
			}

			const exposedName = buildExposedName(server, tool);
			if (byExposedName.has(exposedName)) {
				throw new Error(`MCP 工具名映射冲突：暴露名 "${exposedName}" 已被注册`);
			}

			const entry: McpToolCatalogEntry = {
				serverId: input.serverId,
				nativeToolName: input.nativeToolName,
				exposedName,
				description: input.description,
				inputSchema: input.inputSchema,
				...(input.annotations ? { annotations: input.annotations } : {}),
			};
			catalog.push(entry);
			byExposedName.set(exposedName, entry);
		}

		this._catalog = catalog;
		this._byExposedName = byExposedName;
	}

	/**
	 * 返回不可变 catalog 快照（按注册顺序）。
	 * @returns catalog entry 数组
	 */
	getCatalog(): readonly McpToolCatalogEntry[] {
		return this._catalog;
	}

	/**
	 * 通过暴露名查找 catalog entry（执行时使用，禁止临时拆分）。
	 * @param exposedName 模型可见的暴露名
	 * @returns catalog entry 或 undefined
	 */
	getByExposedName(exposedName: string): McpToolCatalogEntry | undefined {
		return this._byExposedName.get(exposedName);
	}
}
