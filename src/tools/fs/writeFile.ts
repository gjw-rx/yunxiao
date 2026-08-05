/**
 * fs.write_file - 写文本文件（write 权限，经审批网关）。
 * 职责：经 pathGuard 解析 -> 自动建父目录 -> 原子写入（临时文件 + rename）-> 返回结果。
 * 覆盖检测：目标已存在时 metadata 标注 overwritten（审批提示由路由层基于 permission 触发）。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import { resolveWithinRoots } from './pathGuard';
import { PathGuardError, ToolValidationError } from '../../core/errors';
import type { ToolSchema } from '../../core/types';

export class WriteFileTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.write_file',
		description: '向工作区内写入文本文件（UTF-8），自动创建父目录，原子写入。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '相对工作区根的文件路径' },
				content: { type: 'string', description: '文件内容（UTF-8 文本）' },
			},
			required: ['path', 'content'],
		},
		permissions: 'write',
		site: 'local',
	};

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'path');
		if (typeof args.content !== 'string') {
			throw new ToolValidationError('参数 content 必须为字符串');
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const inputPath = args.path as string;
		const content = args.content as string;
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

		// 2. 覆盖检测
		let overwritten = false;
		try {
			await fs.stat(resolved.fsPath);
			overwritten = true;
		} catch {
			// 不存在 -> 新建
		}
		// 3. 自动建父目录 + 原子写入（临时文件 + rename）
		const dir = path.dirname(resolved.fsPath);
		const tmpPath = path.join(
			dir,
			`.${path.basename(resolved.fsPath)}.${crypto.randomUUID()}.tmp`
		);
		try {
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(tmpPath, content, 'utf8');
			await fs.rename(tmpPath, resolved.fsPath);
		} catch (err) {
			// 清理残留临时文件（best-effort，忽略清理错误）
			await fs.rm(tmpPath, { force: true, recursive: true }).catch(() => {});
			return {
				status: 'error',
				error: `写入文件失败: ${inputPath}（${err instanceof Error ? err.message : String(err)}）`,
			};
		}

		return {
			status: 'success',
			result: overwritten ? `已覆盖: ${inputPath}` : `已创建: ${inputPath}`,
			metadata: {
				affected_files: [resolved.relativePath],
				duration_ms: Date.now() - startedAt,
			},
		};
	}
}
