/**
 * fs.read_file - 首个本地工具（只读，无需审批）。
 * 职责：经 pathGuard 解析路径 -> 大小限制 -> 二进制检测 -> 敏感文件脱敏 -> 返回文本内容。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import { resolveWithinRoots } from './pathGuard';
import { PathGuardError } from '../../core/errors';
import type { ToolSchema } from '../../core/types';

/** 默认读文件大小上限：1MB。 */
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

/** 二进制文件扩展名集合。 */
const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff',
	'.pdf', '.zip', '.gz', '.tar', '.rar', '.7z',
	'.class', '.so', '.dll', '.exe', '.bin', '.o',
	'.woff', '.woff2', '.ttf', '.eot', '.otf',
	'.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flac',
]);

/** 敏感信息脱敏规则。 */
const SECRET_PATTERNS: readonly { re: RegExp; replacement: string }[] = [
	{ re: /(api[_-]?key\s*[:=]\s*)([^\s,;"']{8,})/gi, replacement: '$1***' },
	{ re: /(secret\s*[:=]\s*)([^\s,;"']{8,})/gi, replacement: '$1***' },
	{ re: /(password\s*[:=]\s*)([^\s,;"']{4,})/gi, replacement: '$1***' },
	{ re: /(token\s*[:=]\s*)([^\s,;"']{8,})/gi, replacement: '$1***' },
	{ re: /AKIA[0-9A-Z]{16}/g, replacement: '***' },
	{ re: /sk-[a-zA-Z0-9]{20,}/g, replacement: '***' },
];

/** 判断路径是否为二进制文件（按扩展名）。 */
export function isBinaryExt(filePath: string): boolean {
	return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** 对内容进行敏感信息脱敏。 */
export function redactSecrets(content: string): string {
	let redacted = content;
	for (const { re, replacement } of SECRET_PATTERNS) {
		redacted = redacted.replace(re, replacement);
	}
	return redacted;
}

export class ReadFileTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.read_file',
		description: '读取工作区内文本文件内容（UTF-8）。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '相对工作区根的文件路径' },
			},
			required: ['path'],
		},
		permissions: 'read',
		site: 'local',
		canParallel: true,
	};

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'path');
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const inputPath = args.path as string;
		const maxFileSize = context.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
		const startedAt = Date.now();

		// 1. 路径安全解析
		let resolved;
		try {
			resolved = await resolveWithinRoots(inputPath, context.workspaceRoots, {
				followSymlinks: true,
			});
		} catch (err) {
			if (err instanceof PathGuardError) {
				return { status: 'error', error: err.message };
			}
			throw err;
		}

		// 2. stat 取大小、判断存在
		let stat;
		try {
			stat = await fs.stat(resolved.fsPath);
		} catch {
			return { status: 'error', error: `文件不存在: ${inputPath}` };
		}
		if (stat.size > maxFileSize) {
			return {
				status: 'error',
				error: `文件超过大小上限 ${maxFileSize} 字节（实际 ${stat.size} 字节）`,
			};
		}

		// 3. 二进制检测（扩展名）
		if (isBinaryExt(resolved.fsPath)) {
			return { status: 'error', error: `二进制文件，不以文本返回: ${inputPath}` };
		}

		// 4. 读取内容
		let content: string;
		try {
			content = await fs.readFile(resolved.fsPath, 'utf8');
		} catch {
			return { status: 'error', error: `读取文件失败: ${inputPath}` };
		}

		// 5. 二进制检测（内容 NUL 字节）
		if (content.includes('\0')) {
			return { status: 'error', error: `二进制文件，不以文本返回: ${inputPath}` };
		}

		// 6. 敏感文件脱敏 + 警告
		if (resolved.sensitive) {
			content = redactSecrets(content);
			context.warn?.(`访问敏感文件 ${resolved.relativePath}，内容中的密钥已脱敏`);
		}

		return {
			status: 'success',
			result: content,
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}
}
