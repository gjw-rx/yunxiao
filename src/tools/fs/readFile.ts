/**
 * fs_read_file - 本地只读工具（无需审批）。
 * 职责：pathGuard 解析路径 -> 二进制检测 -> 流式分页读取（行数 + 字节双预算）-> 敏感文件脱敏 -> 返回带行号文本。
 * 大文件不再整体拒绝：默认返回前 2000 行，可用 offset/limit 分页续读；单行超过 2000 字符截断标注。
 */
import { createReadStream } from 'fs';
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
import * as logger from '../../logger';

/** 默认读文件大小上限：1MB（作为字节预算的护栏，超过不再整体拒绝，按预算分页返回）。 */
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
/** 默认单页最大行数。 */
export const DEFAULT_READ_LIMIT = 2000;
/** 默认累计字节预算（UTF-8 字节，超过即停止读取）。 */
export const DEFAULT_MAX_BYTES = 50 * 1024;
/** 默认单行最大字符数（超出截断并标注）。 */
export const DEFAULT_MAX_LINE_LENGTH = 2000;

/** 单行截断后缀。 */
const MAX_LINE_SUFFIX = `... (line truncated to ${DEFAULT_MAX_LINE_LENGTH} chars)`;

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

/** 分页读取结果。 */
interface ReadPageResult {
	/** 已收集的行（不含行号前缀）。 */
	lines: string[];
	/** 已扫描到的行数（越界判断与总数提示用）。 */
	totalCount: number;
	/** 是否因字节预算提前截断。 */
	cut: boolean;
	/** 是否因行数预算未读完（还有更多行）。 */
	more: boolean;
	/** 是否检测到二进制内容（NUL 字节）。 */
	binary: boolean;
}

/**
 * 流式逐行读取指定行区间，受行数与字节双预算约束。
 * 行数预算满后继续有限扫描以得到近似行数（扫描字节受 maxBytes 约束，避免大文件全量读取）；
 * 字节超限立即停止；无换行的超长行不会无限累积内存（超 maxLineLength 即截断丢弃）。
 */
function readLinesPaged(
	filePath: string,
	opts: { offset: number; limit: number; maxBytes: number; maxLineLength: number },
): Promise<ReadPageResult> {
	return new Promise((resolve, reject) => {
		const start = opts.offset - 1;
		const lines: string[] = [];
		const flags = {
			count: 0,
			bytes: 0,
			tailBytes: 0,
			cut: false,
			more: false,
			binary: false,
			done: false,
		};
		// 无换行超长行的处理状态：overlong=true 表示当前行已超长，\n 到来时用截断内容
		let overlong = false;
		let truncatedContent = '';
		const decoder = new TextDecoder('utf-8');
		let buffer = '';

		const finish = () =>
			resolve({
				lines,
				totalCount: flags.count,
				cut: flags.cut,
				more: flags.more,
				binary: flags.binary,
			});
		const stop = () => {
			flags.done = true;
			stream.destroy();
			finish();
		};

		/** 处理一行（含单行截断、字节预算含行号前缀、收集/截断判定）。 */
		const processLine = (line: string) => {
			if (flags.done) {
				return;
			}
			const trimmed =
				line.length > opts.maxLineLength
					? line.slice(0, opts.maxLineLength) + MAX_LINE_SUFFIX
					: line;
			// 字节预算计入行号前缀（`${count}: `），保证实际输出不超预算
			const size = Buffer.byteLength(`${flags.count}: ${trimmed}`, 'utf-8') + (lines.length > 0 ? 1 : 0);
			if (flags.bytes + size <= opts.maxBytes) {
				lines.push(trimmed);
				flags.bytes += size;
			} else {
				flags.cut = true;
				flags.more = true;
				stop();
			}
		};

		const stream = createReadStream(filePath);
		stream.on('data', (chunk: string | Buffer) => {
			if (flags.done) {
				return;
			}
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			// 内容 NUL 字节判定为二进制（不收集）
			if (buf.includes(0)) {
				flags.binary = true;
				stop();
				return;
			}
			buffer += decoder.decode(buf, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (flags.done) {
					return;
				}
				flags.count += 1;
				// 跳过 offset 之前的行
				if (flags.count <= start) {
					continue;
				}
				// 行数预算已满：继续有限扫描计数（受扫描字节预算约束），不收集
				if (lines.length >= opts.limit) {
					flags.more = true;
					flags.tailBytes += Buffer.byteLength(line, 'utf-8');
					if (flags.tailBytes > opts.maxBytes) {
						stop();
						return;
					}
					continue;
				}
				if (overlong) {
					// 该行之前已被判定超长，用截断内容
					processLine(truncatedContent + MAX_LINE_SUFFIX);
					overlong = false;
				} else {
					processLine(line);
				}
				if (flags.done) {
					return;
				}
			}
			// 无换行的剩余内容：若超长则保留截断前缀并丢弃其余，避免内存无限累积
			if (buffer.length > opts.maxLineLength) {
				overlong = true;
				truncatedContent = buffer.slice(0, opts.maxLineLength);
				buffer = '';
			}
		});
		stream.on('end', () => {
			if (flags.done) {
				return;
			}
			// 处理最后一行（文件不以换行结尾时）
			if (buffer.length > 0 || overlong) {
				flags.count += 1;
				if (flags.count > start && lines.length < opts.limit) {
					processLine(overlong ? truncatedContent + MAX_LINE_SUFFIX : buffer);
				}
			}
			finish();
		});
		stream.on('error', (err) => {
			if (!flags.done) {
				reject(err);
			}
		});
	});
}

export class ReadFileTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs_read_file',
		description:
			'读取工作区内文本文件内容（UTF-8）。输出带行号；大文件默认返回前 2000 行，可用 offset 续读；' +
			'单行超过 2000 字符会被截断；目录请用 fs_list_dir。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '相对工作区根的文件路径' },
				offset: { type: 'integer', minimum: 1, description: '起始行号（1 起始，默认 1）' },
				limit: { type: 'integer', minimum: 1, description: '最大返回行数（默认 2000）' },
			},
			required: ['path'],
		},
		permissions: 'read',
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
		const offset = typeof args.offset === 'number' ? args.offset : 1;
		const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_READ_LIMIT;
		// 字节预算 = min(单页预算, maxFileSize 护栏)
		const maxBytes = Math.min(
			context.readMaxBytes ?? DEFAULT_MAX_BYTES,
			context.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
		);
		const maxLineLength = context.readMaxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
		const startedAt = Date.now();
		logger.log(`[fs_read_file] 开始 - path=${inputPath}, offset=${offset}, limit=${limit}`);

		// 1. 路径安全解析
		let resolved;
		try {
			resolved = await resolveWithinRoots(inputPath, context.workspaceRoots, {
				followSymlinks: true,
			});
		} catch (err) {
			if (err instanceof PathGuardError) {
				logger.error(`[fs_read_file] 路径解析失败 - path=${inputPath}, error=${err.message}`);
				return { status: 'error', error: err.message };
			}
			throw err;
		}

		// 2. stat 判断存在
		let stat;
		try {
			stat = await fs.stat(resolved.fsPath);
		} catch {
			return { status: 'error', error: `文件不存在: ${inputPath}` };
		}
		if (stat.isDirectory()) {
			return { status: 'error', error: `是目录而非文件，请用 fs_list_dir: ${inputPath}` };
		}

		// 3. 二进制检测（扩展名）
		if (isBinaryExt(resolved.fsPath)) {
			return { status: 'error', error: `二进制文件，不以文本返回: ${inputPath}` };
		}

		// 4. 流式分页读取（行数 + 字节双预算，大文件不再整体拒绝）
		let page: ReadPageResult;
		try {
			page = await readLinesPaged(resolved.fsPath, { offset, limit, maxBytes, maxLineLength });
		} catch {
			return { status: 'error', error: `读取文件失败: ${inputPath}` };
		}

		// 5. 内容 NUL 字节二进制检测
		if (page.binary) {
			return { status: 'error', error: `二进制文件，不以文本返回: ${inputPath}` };
		}

		// 6. offset 越界检测
		if (page.totalCount < offset && !(page.totalCount === 0 && offset === 1)) {
			return {
				status: 'error',
				error: `Offset ${offset} is out of range for this file (${page.totalCount} lines)`,
			};
		}

		// 7. 组装输出：带行号 + 三种结尾标注
		let output = [`<path>${resolved.fsPath}</path>`, `<type>file</type>`, '<content>'].join('\n');
		output += '\n' + page.lines.map((line, i) => `${i + offset}: ${line}`).join('\n');
		const last = offset + page.lines.length - 1;
		const next = last + 1;
		if (page.cut) {
			output += `\n\n(Output capped at ${Math.round(maxBytes / 1024)}KB. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`;
		} else if (page.more) {
			output += `\n\n(Showing lines ${offset}-${last} of ${page.totalCount}. Use offset=${next} to continue.)`;
		} else {
			output += `\n\n(End of file - total ${page.totalCount} lines)`;
		}
		output += '\n</content>';

		// 8. 敏感文件脱敏 + 警告
		if (resolved.sensitive) {
			output = redactSecrets(output);
			context.warn?.(`访问敏感文件 ${resolved.relativePath}，内容中的密钥已脱敏`);
			logger.log(`[fs_read_file] 访问敏感文件 - path=${resolved.relativePath}, 密钥已脱敏`);
		}

		logger.log(`[fs_read_file] 完成 - path=${inputPath}, lines=${page.lines.length}, totalCount=${page.totalCount}, duration_ms=${Date.now() - startedAt}`);
		return {
			status: 'success',
			result: output,
			metadata: {
				duration_ms: Date.now() - startedAt,
				truncated: page.more || page.cut,
			},
		};
	}
}
