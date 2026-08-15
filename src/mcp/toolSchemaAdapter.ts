/**
 * MCP 工具 schema 转换器 — 将 MCP catalog entry 转换为本地 ToolSchema。
 *
 * 职责：
 * - 使用 MCP Tool description 与 inputSchema 构造 ToolSchema
 * - 缺失 inputSchema 时回退为禁止额外字段的空对象 schema
 * - description 标识来源 Server，不维护第二份手写参数 schema
 * - 权限保守映射：destructiveHint > readOnlyHint > execute
 * - canParallel：仅明确只读且非 open-world 的工具可并行
 * - Transport 不影响权限（权限只由 annotations 决定）
 *
 * 安全约定：转换器是纯函数，不持有 Secret/Transport/Manager 引用。
 */
import type { McpToolCatalogEntry, McpToolAnnotations } from './types';
import type { ToolSchema, Permission } from '../core/types';

/** 禁止额外字段的空对象 schema（缺失 inputSchema 时回退）。 */
const EMPTY_STRICT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {},
	additionalProperties: false,
};

/**
 * 由 MCP annotations 保守映射本地权限级别。
 *
 * 规则（destructive 优先）：
 * - destructiveHint: true → destructive
 * - readOnlyHint: true → read
 * - 其余 → execute
 *
 * 不根据工具名或 Transport 猜测权限。
 * @param annotations MCP 工具 annotations（可选）
 * @returns 本地权限级别
 */
function mapPermission(annotations?: McpToolAnnotations): Permission {
	if (annotations?.destructiveHint) {
		return 'destructive';
	}
	if (annotations?.readOnlyHint) {
		return 'read';
	}
	return 'execute';
}

/**
 * 判断 MCP 工具是否可与其他工具并行执行。
 *
 * 规则：仅明确 readOnlyHint: true 且 openWorldHint 非 true（缺省 false）时可并行。
 * @param annotations MCP 工具 annotations（可选）
 * @returns 是否可并行
 */
function canParallel(annotations?: McpToolAnnotations): boolean {
	if (!annotations?.readOnlyHint) {
		return false;
	}
	// openWorldHint 缺省为 false；仅显式 true 时禁止并行
	return annotations.openWorldHint !== true;
}

/**
 * 将 MCP catalog entry 转换为本地 ToolSchema。
 *
 * - name：使用 entry.exposedName（mcp__<server>__<tool>）
 * - description：组合 MCP 原始 description 与来源 Server ID
 * - parameters：原样复用 MCP inputSchema；空对象回退为禁止额外字段的空 schema
 * - permissions：由 annotations 保守映射
 * - canParallel：仅明确只读且非 open-world 时为 true
 *
 * @param entry MCP 工具 catalog entry
 * @returns 本地 ToolSchema
 */
export function convertMcpToolToSchema(entry: McpToolCatalogEntry): ToolSchema {
	const isEmptySchema = !entry.inputSchema || Object.keys(entry.inputSchema).length === 0;
	const parameters = isEmptySchema ? { ...EMPTY_STRICT_SCHEMA } : entry.inputSchema;
	const description = `[MCP/${entry.serverId}] ${entry.description}`;

	return {
		name: entry.exposedName,
		description,
		parameters,
		permissions: mapPermission(entry.annotations),
		canParallel: canParallel(entry.annotations),
	};
}
