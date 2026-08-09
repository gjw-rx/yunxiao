/**
 * fs.search_files - 文件内容搜索（read 权限，免审批）。
 * 优先 ripgrep（`rg`）：regex 模式 `rg --json -C <n> <pattern>`，glob 模式 `rg --files -g <glob>`。
 * rg 缺失（spawn ENOENT）回退 Node 原生搜索（限文件数/大小，避免 OOM）。
 * 返回匹配位置 + 上下文行。结果上限 MAX_MATCHES，超限标注 truncated。
 */
import { spawn } from 'child_process';
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

/** 单条匹配。 */
interface SearchMatch {
	file: string;
	line?: number;
	column?: number;
	text?: string;
	context?: string[];
}

/** 默认上下文行数。 */
const DEFAULT_CONTEXT_LINES = 2;
/** 结果上限。 */
const MAX_MATCHES = 100;
/** Node 回退扫描文件数上限。 */
const NODE_FALLBACK_MAX_FILES = 500;

export class SearchFilesTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.search_files',
		description: '搜索工作区文件内容（ripgrep 优先，缺失回退 Node）。支持 regex 与 glob 两种模式。用于代码探索与模糊定位，替代已移除的 code.search_index。',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: '搜索模式（regex 时为正则，glob 时为文件名通配）' },
				mode: {
					type: 'string',
					enum: ['regex', 'glob'],
					description: '搜索模式，默认 regex',
				},
				path: { type: 'string', description: '搜索根目录（相对工作区根，默认工作区根）' },
				contextLines: { type: 'number', description: '上下文行数（默认 2）' },
			},
			required: ['pattern'],
		},
		permissions: 'read',
	};

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'pattern');
		const m = args.mode;
		if (m !== undefined && m !== 'regex' && m !== 'glob') {
			throw new Error('参数 mode 必须为 regex | glob');
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const pattern = args.pattern as string;
		const mode = (args.mode as 'regex' | 'glob') ?? 'regex';
		const inputPath = (args.path as string) ?? '.';
		const contextLines =
			typeof args.contextLines === 'number' ? args.contextLines : DEFAULT_CONTEXT_LINES;
		const startedAt = Date.now();
		logger.log(`[fs.search_files] 开始 - pattern=${pattern.slice(0, 100)}, mode=${mode}, path=${inputPath}`);

		// 1. 路径安全解析（搜索根）
		let resolved;
		try {
			resolved = await resolveWithinRoots(inputPath, context.workspaceRoots, {
				followSymlinks: false,
			});
		} catch (err) {
			if (err instanceof PathGuardError) {
				logger.error(`[fs.search_files] 路径解析失败 - path=${inputPath}, error=${err.message}`);
				return { status: 'error', error: err.message };
			}
			throw err;
		}

		// 2. 优先 ripgrep
		let matches: SearchMatch[] = [];
		let truncated = false;
		let usedFallback = false;
		try {
			const rgResult = await this.runRipgrep(pattern, resolved.fsPath, mode, contextLines);
			matches = rgResult;
		} catch (err) {
			if (isENOENT(err)) {
				// rg 不存在，回退 Node
				logger.log(`[fs.search_files] rg 不可用，回退 Node 搜索 - path=${resolved.fsPath}`);
				usedFallback = true;
				matches = await this.nodeSearch(
					pattern,
					resolved.fsPath,
					mode,
					contextLines,
					context.maxFileSize
				);
			} else {
				logger.error(`[fs.search_files] ripgrep 执行失败 - error=${err instanceof Error ? err.message : String(err)}`);
				return {
					status: 'error',
					error: `ripgrep 执行失败: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}

		if (matches.length > MAX_MATCHES) {
			truncated = true;
			matches = matches.slice(0, MAX_MATCHES);
		}

		// 转为相对工作区根的路径
		const root = resolved.root;
		matches = matches.map((m) => ({
			...m,
			file: path.relative(root, path.resolve(resolved.fsPath, m.file)).split(path.sep).join('/'),
		}));

		logger.log(`[fs.search_files] 完成 - path=${inputPath}, matches=${matches.length}, truncated=${truncated}, fallback=${usedFallback}, duration_ms=${Date.now() - startedAt}`);
		return {
			status: 'success',
			result: JSON.stringify(
				{ matches, truncated, fallback: usedFallback },
				null,
				2
			),
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}

	/** 调用 ripgrep 并解析输出。rg 缺失抛 ENOENT 供上层回退。 */
	private async runRipgrep(
		pattern: string,
		root: string,
		mode: 'regex' | 'glob',
		contextLines: number
	): Promise<SearchMatch[]> {
		const args =
			mode === 'glob'
				? ['--files', '-g', pattern, root]
				: ['--json', '-C', String(contextLines), pattern, root];
		const stdout = await this.spawnRg(args);
		if (mode === 'glob') {
			return stdout
				.split('\n')
				.filter((l) => l.trim())
				.map((file) => ({ file }));
		}
		return parseRgJson(stdout, contextLines);
	}

	/** spawn rg，捕获 stdout；rg 不存在时 reject 带 ENOENT 标记。protected 供测试覆盖以触发 Node 回退。 */
	protected spawnRg(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			const proc = spawn('rg', args, { cwd: process.cwd() });
			let stdout = '';
			let stderr = '';
			proc.stdout.on('data', (d) => (stdout += d.toString()));
			proc.stderr.on('data', (d) => (stderr += d.toString()));
			proc.on('error', (err) => {
				// ENOENT: rg 不在 PATH
				(err as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code ?? 'ENOENT';
				reject(err);
			});
			proc.on('close', (code) => {
				if (code === 0 || code === 1) {
					// 0: 有匹配, 1: 无匹配，均正常
					resolve(stdout);
				} else {
					reject(new Error(`rg 退出码 ${code}: ${stderr.slice(0, 200)}`));
				}
			});
		});
	}

	/** Node 原生回退搜索。限文件数/大小。 */
	private async nodeSearch(
		pattern: string,
		root: string,
		mode: 'regex' | 'glob',
		contextLines: number,
		maxFileSize?: number
	): Promise<SearchMatch[]> {
		const matches: SearchMatch[] = [];
		let fileCount = 0;
		const sizeLimit = maxFileSize ?? 1024 * 1024;
		const isGlob = mode === 'glob';
		let regex: RegExp;
		try {
			regex = isGlob ? globToRegex(pattern) : new RegExp(pattern);
		} catch {
			throw new Error(`无效的${isGlob ? ' glob' : '正则'}模式: ${pattern}`);
		}

		const walk = async (dir: string): Promise<void> => {
			if (fileCount >= NODE_FALLBACK_MAX_FILES) {
				return;
			}
			let dirents;
			try {
				dirents = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const dirent of dirents) {
				if (fileCount >= NODE_FALLBACK_MAX_FILES) {
					return;
				}
				const abs = path.join(dir, dirent.name);
				if (dirent.isDirectory()) {
					if (dirent.name === 'node_modules' || dirent.name === '.git') {
						continue;
					}
					await walk(abs);
				} else if (dirent.isFile()) {
					fileCount++;
					const rel = path.relative(root, abs);
					if (isGlob) {
						if (regex.test(dirent.name)) {
							matches.push({ file: rel });
						}
						continue;
					}
					// 内容搜索
					try {
						const stat = await fs.stat(abs);
						if (stat.size > sizeLimit) {
							continue;
						}
						const content = await fs.readFile(abs, 'utf8');
						const lines = content.split('\n');
						for (let i = 0; i < lines.length; i++) {
							if (regex.test(lines[i])) {
								const ctx: string[] = [];
								for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
									if (j !== i) {
										ctx.push(lines[j]);
									}
								}
								matches.push({
									file: rel,
									line: i + 1,
									column: lines[i].search(regex) + 1,
									text: lines[i],
									context: ctx,
								});
							}
						}
					} catch {
						// 二进制/无权限文件跳过
					}
				}
			}
		};

		await walk(root);
		return matches;
	}
}

/** 解析 rg --json 输出为匹配列表（含上下文）。纯函数，可单测。 */
export function parseRgJson(output: string, contextLines: number): SearchMatch[] {
	const entries: {
		type: string;
		file: string;
		line: number;
		text: string;
		column?: number;
	}[] = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let obj: { type: string; data?: Record<string, unknown> };
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (obj.type !== 'match' && obj.type !== 'context') {
			continue;
		}
		const data = obj.data ?? {};
		const pathText =
			typeof data.path === 'object' && data.path !== null
				? (data.path as { text?: string }).text ?? ''
				: String(data.path ?? '');
		const linesText =
			typeof data.lines === 'object' && data.lines !== null
				? (data.lines as { text?: string }).text ?? ''
				: String(data.lines ?? '');
		const entry = {
			type: obj.type,
			file: pathText,
			line: data.line_number as number,
			text: linesText.replace(/\n$/, ''),
			column: undefined as number | undefined,
		};
		if (obj.type === 'match') {
			const submatches = data.submatches as { start?: number }[] | undefined;
			entry.column = (submatches?.[0]?.start ?? 0) + 1;
		}
		entries.push(entry);
	}

	const matches: SearchMatch[] = entries
		.filter((e) => e.type === 'match')
		.map((m) => {
			const ctx = entries
				.filter(
					(e) =>
						e.type === 'context' &&
						e.file === m.file &&
						e.line >= m.line - contextLines &&
						e.line <= m.line + contextLines
				)
				.map((e) => e.text);
			return {
				file: m.file,
				line: m.line,
				column: m.column,
				text: m.text,
				context: ctx,
			};
		});
	return matches;
}

/** 简单 glob 转 regex（支持 * 与 ?）。 */
function globToRegex(glob: string): RegExp {
	const regex = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.');
	return new RegExp(`^${regex}$`);
}

/** 判断错误是否为 rg 不存在（ENOENT）。 */
function isENOENT(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err as NodeJS.ErrnoException).code === 'ENOENT'
	);
}
