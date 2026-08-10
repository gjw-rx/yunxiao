/**
 * fs_list_dir - 列目录（read 权限，免审批）。
 * 职责：经 pathGuard 解析目录 -> 列条目（名称/类型/大小/修改时间）-> 尊重 .gitignore 过滤 -> 类型过滤。
 * 默认非递归（单层）；recursive:true 递归（深度上限 MAX_DEPTH 防 token 爆炸）。
 * 用 Node fs（与 readFile 一致，便于无 vscode 单测）。.gitignore 为最小匹配器，非完整语义（需完整语义请用 search_files 的 ripgrep）。
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
import * as logger from '../../logger';

/** 递归深度上限。 */
const MAX_DEPTH = 3;

/** 单页默认最大条目数。 */
export const DEFAULT_LIST_LIMIT = 2000;

/** 内置常见忽略目录（即使无 .gitignore 也排除，避免噪声）。 */
const BUILTIN_IGNORE = new Set([
	'node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.next', '.cache',
]);

/** 单个目录条目。 */
interface DirEntry {
	name: string;
	type: 'file' | 'dir';
	size: number;
	mtime: number;
	/** 相对工作区根的路径。 */
	path: string;
}

export class ListDirTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs_list_dir',
		description:
			'列出工作区内目录条目（含类型/大小/修改时间），尊重 .gitignore，默认单层。' +
			'条目较多时默认返回前 2000 条，可用 offset/limit 分页续读。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '相对工作区根的目录路径（默认工作区根）' },
				type: {
					type: 'string',
					enum: ['file', 'dir', 'all'],
					description: '过滤类型，默认 all',
				},
				recursive: { type: 'boolean', description: '是否递归列出（默认 false，深度上限 3）' },
				offset: { type: 'integer', minimum: 1, description: '起始条目序号（1 起始，默认 1）' },
				limit: { type: 'integer', minimum: 1, description: '最大返回条目数（默认 2000）' },
			},
			required: ['path'],
		},
		permissions: 'read',
	};

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'path');
		const t = args.type;
		if (t !== undefined && t !== null && t !== 'file' && t !== 'dir' && t !== 'all') {
			throw new Error('参数 type 必须为 file | dir | all');
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const inputPath = args.path as string;
		const typeFilter = (args.type as 'file' | 'dir' | 'all') ?? 'all';
		const recursive = args.recursive === true;
		const offset = typeof args.offset === 'number' ? args.offset : 1;
		const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIST_LIMIT;
		const startedAt = Date.now();
		logger.log(`[fs_list_dir] 开始 - path=${inputPath}, type=${typeFilter}, recursive=${recursive}, offset=${offset}, limit=${limit}`);

		// 1. 路径安全解析
		let resolved;
		try {
			resolved = await resolveWithinRoots(inputPath, context.workspaceRoots, {
				followSymlinks: true,
			});
		} catch (err) {
			if (err instanceof PathGuardError) {
				logger.error(`[fs_list_dir] 路径解析失败 - path=${inputPath}, error=${err.message}`);
				return { status: 'error', error: err.message };
			}
			throw err;
		}

		// 2. 校验是目录
		try {
			const stat = await fs.stat(resolved.fsPath);
			if (!stat.isDirectory()) {
				return { status: 'error', error: `不是目录: ${inputPath}` };
			}
		} catch {
			return { status: 'error', error: `目录不存在: ${inputPath}` };
		}

		// 3. 加载 .gitignore 模式（工作区根）
		const ignorePatterns = await this.loadGitignore(resolved.root);

		// 4. 列条目
		const entries: DirEntry[] = [];
		await this.collectEntries(
			resolved.fsPath,
			resolved.root,
			resolved.fsPath,
			entries,
			ignorePatterns,
			typeFilter,
			recursive,
			0
		);

		logger.log(`[fs_list_dir] 完成 - path=${inputPath}, entries=${entries.length}, duration_ms=${Date.now() - startedAt}`);
		// offset 越界：与 fs_read_file 一致返回 error（含总条数）
		if (entries.length > 0 && offset > entries.length) {
			return {
				status: 'error',
				error: `Offset ${offset} is out of range for this directory (${entries.length} entries)`,
			};
		}
		// 分页切片：offset 1 起始，超限提示续读
		const start = offset - 1;
		const sliced = entries.slice(start, start + limit);
		const truncated = start + sliced.length < entries.length;
		let result = JSON.stringify(sliced, null, 2);
		if (truncated) {
			result += `\n\n(Showing ${sliced.length} of ${entries.length} entries. Use offset=${offset + sliced.length} to continue.)`;
		} else {
			result += `\n\n(${entries.length} entries)`;
		}
		return {
			status: 'success',
			result,
			metadata: { duration_ms: Date.now() - startedAt, truncated },
		};
	}

	/** 递归收集条目。 */
	private async collectEntries(
		dirAbs: string,
		workspaceRoot: string,
		listRoot: string,
		out: DirEntry[],
		ignorePatterns: string[],
		typeFilter: 'file' | 'dir' | 'all',
		recursive: boolean,
		depth: number
	): Promise<void> {
		let dirents;
		try {
			dirents = await fs.readdir(dirAbs, { withFileTypes: true });
		} catch {
			return; // 无权限读取的子目录跳过
		}
		for (const dirent of dirents) {
			// 内置忽略 + .gitignore 匹配（基于 basename）
			if (BUILTIN_IGNORE.has(dirent.name)) {
				continue;
			}
			const relToDir = path.relative(listRoot, path.join(dirAbs, dirent.name));
			if (this.isIgnored(dirent.name, relToDir, ignorePatterns)) {
				continue;
			}
			const abs = path.join(dirAbs, dirent.name);
			const type: 'file' | 'dir' = dirent.isDirectory() ? 'dir' : 'file';
			// 类型过滤
			if (typeFilter !== 'all' && type !== typeFilter) {
				// 若是目录且递归，仍需下钻（其下可能有匹配的文件）
				if (!recursive || type !== 'dir') {
					continue;
				}
			}
			let size = 0;
			let mtime = 0;
			try {
				const stat = await fs.stat(abs);
				size = stat.size;
				mtime = stat.mtimeMs;
			} catch {
				// stat 失败用默认值
			}
			if (typeFilter === 'all' || type === typeFilter) {
				out.push({
					name: dirent.name,
					type,
					size,
					mtime,
					path: path.relative(workspaceRoot, abs).split(path.sep).join('/'),
				});
			}
			// 递归下钻
			if (recursive && type === 'dir' && depth < MAX_DEPTH) {
				await this.collectEntries(
					abs,
					workspaceRoot,
					listRoot,
					out,
					ignorePatterns,
					typeFilter,
					recursive,
					depth + 1
				);
			}
		}
	}

	/** 从工作区根读取 .gitignore 模式（简单解析，不处理嵌套 .gitignore / negation）。 */
	private async loadGitignore(workspaceRoot: string): Promise<string[]> {
		try {
			const content = await fs.readFile(path.join(workspaceRoot, '.gitignore'), 'utf8');
			return content
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
		} catch {
			return [];
		}
	}

	/** 简单 glob 匹配（支持 * 通配，不递归路径）。 */
	private isIgnored(name: string, relPath: string, patterns: string[]): boolean {
		for (const p of patterns) {
			const pat = p.replace(/\/$/, ''); // 去尾部分隔符
			if (pat === name || pat === relPath) {
				return true;
			}
			if (pat.includes('*') && this.simpleGlobMatch(pat, name)) {
				return true;
			}
		}
		return false;
	}

	private simpleGlobMatch(pattern: string, name: string): boolean {
		const regex = new RegExp(
			'^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
		);
		return regex.test(name);
	}
}
