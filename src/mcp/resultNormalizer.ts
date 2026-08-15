/**
 * MCP CallToolResult 归一化器 — 将 MCP 返回的 CallToolResult 确定性转换为本地文本与 metadata。
 *
 * 职责：
 * - 保留 text content 原文
 * - 序列化 structuredContent 为 JSON
 * - 包含 text resource 与 resource link 的 URI/MIME
 * - 对 image/audio/blob 与未知类型返回安全描述，不内联 base64
 * - isError: true 转为 error 状态
 * - 多段内容按顺序拼接
 *
 * 安全约定：归一化结果仍需经过 BaseTool.governResult 统一治理（脱敏/截断），
 * 归一化器本身不做治理，只做内容提取与安全描述。
 */
import type { McpResultMetadata } from './types';
import type { ToolCallStatus } from '../core/types';

/** MCP content 项（宽松输入类型，按 type 字段运行时判别）。 */
export type McpContent = { readonly type: string; readonly [key: string]: unknown };

/** MCP CallToolResult（SDK 返回的结构）。 */
export interface McpCallToolResult {
	readonly content?: readonly McpContent[];
	readonly structuredContent?: Readonly<Record<string, unknown>>;
	readonly isError?: boolean;
}

/** 归一化结果。 */
export interface NormalizedMcpResult {
	readonly status: ToolCallStatus;
	readonly result: string;
	readonly metadata: McpResultMetadata;
}

/**
 * 将单个 MCP content 项归一化为文本段。
 *
 * @param content MCP content 项（按 type 字段判别）
 * @returns 归一化文本段（不含 base64）
 */
function normalizeContent(content: McpContent): string {
	const type = content.type;

	if (type === 'text') {
		return typeof content.text === 'string' ? content.text : '';
	}

	if (type === 'image') {
		const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'unknown';
		return `[unsupported: image (${mimeType})]`;
	}

	if (type === 'audio') {
		const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'unknown';
		return `[unsupported: audio (${mimeType})]`;
	}

	if (type === 'resource') {
		const resource = content.resource as { uri?: string; mimeType?: string; text?: string; blob?: string } | undefined;
		if (!resource) {
			return '[unsupported: resource (missing resource field)]';
		}
		const uri = resource.uri ?? 'unknown';
		const mime = resource.mimeType ?? 'unknown';
		if (typeof resource.text === 'string') {
			return `[resource: ${uri} (${mime})]\n${resource.text}`;
		}
		// blob resource — 不内联 base64
		return `[unsupported: blob resource ${uri} (${mime})]`;
	}

	if (type === 'resource_link') {
		const uri = typeof content.uri === 'string' ? content.uri : 'unknown';
		const mime = typeof content.mimeType === 'string' ? content.mimeType : 'unknown';
		const desc = typeof content.description === 'string' ? content.description : '';
		return `[resource_link: ${uri} (${mime})${desc ? ` — ${desc}` : ''}]`;
	}

	return `[unsupported: ${type}]`;
}

/**
 * 检查 content 是否为非文本类型（image/audio/blob/unknown）。
 * @param content MCP content 项
 * @returns 是否为非文本类型
 */
function isUnsupportedContent(content: McpContent): boolean {
	const type = content.type;
	if (type === 'image' || type === 'audio') {
		return true;
	}
	if (type === 'resource') {
		const resource = content.resource as { text?: string } | undefined;
		return !resource || typeof resource.text !== 'string';
	}
	return type !== 'text' && type !== 'resource' && type !== 'resource_link';
}

/**
 * 将 MCP CallToolResult 确定性归一化为本地文本与 metadata。
 *
 * - text content 保留原文
 * - structuredContent 序列化为 JSON 并附加
 * - text resource 与 resource link 包含 URI/MIME
 * - image/audio/blob 与未知类型返回安全描述，不内联 base64
 * - isError: true 转为 error 状态
 * - 多段按顺序拼接
 *
 * @param callResult MCP SDK 返回的 CallToolResult
 * @returns 归一化结果（status + result + metadata）
 */
export function normalizeCallToolResult(callResult: McpCallToolResult): NormalizedMcpResult {
	const contents = callResult.content ?? [];
	const parts: string[] = [];
	let unsupportedContent = false;

	for (const content of contents) {
		if (isUnsupportedContent(content)) {
			unsupportedContent = true;
		}
		parts.push(normalizeContent(content));
	}

	// structuredContent 序列化为 JSON 并附加
	if (callResult.structuredContent !== undefined) {
		parts.push(JSON.stringify(callResult.structuredContent, null, 2));
	}

	const isError = callResult.isError === true;
	const status: ToolCallStatus = isError ? 'error' : 'success';
	const result = parts.join('\n');

	const metadata: McpResultMetadata = {
		...(unsupportedContent ? { unsupportedContent: true } : {}),
		...(isError ? { isError: true } : {}),
	};

	return { status, result, metadata };
}
