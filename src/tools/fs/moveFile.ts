/**
 * fs.move_file - 移动/重命名文件（write 权限，经审批网关）。
 * 职责：pathGuard 解析 from/to -> 覆盖检测 -> 自动建 to 父目录 -> rename（跨设备回退 copy+delete）。
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

export class MoveFileTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs.move_file',
		description: '移动/重命名工作区内文件，自动创建目标父目录（write，需审批）。',
		parameters: {
			type: 'object',
			properties: {
				from: { type: 'string', description: '相对工作区根的源路径' },
				to: { type: 'string', description: '相对工作区根的目标路径' },
			},
			required: ['from', 'to'],
		},
		permissions: 'write',
		site: 'local',
	};

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'from');
		requireStringArg(args, 'to');
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const fromInput = args.from as string;
		const toInput = args.to as string;
		const startedAt = Date.now();

		// 1. 解析 from / to
		let fromResolved, toResolved;
		try {
			[fromResolved, toResolved] = await Promise.all([
				resolveWithinRoots(fromInput, context.workspaceRoots, { followSymlinks: true }),
				resolveWithinRoots(toInput, context.workspaceRoots, { followSymlinks: true }),
			]);
		} catch (err) {
			if (err instanceof PathGuardError) {
				return { status: 'error', error: err.message };
			}
			throw err;
		}

		// 2. 源存在性检查
		try {
			await fs.stat(fromResolved.fsPath);
		} catch {
			return { status: 'error', error: `源文件不存在: ${fromInput}` };
		}

		// 3. 覆盖检测
		let overwritten = false;
		try {
			await fs.stat(toResolved.fsPath);
			overwritten = true;
		} catch {
			// 目标不存在
		}

		// 4. 自动建目标父目录
		await fs.mkdir(path.dirname(toResolved.fsPath), { recursive: true });

		// 5. 移动（跨设备回退 copy+delete）
		try {
			try {
				await fs.rename(fromResolved.fsPath, toResolved.fsPath);
			} catch (err) {
				if (err instanceof Error && /EXDEV|cross-device/i.test(err.message)) {
					await fs.copyFile(fromResolved.fsPath, toResolved.fsPath);
					await fs.rm(fromResolved.fsPath, { force: true });
				} else {
					throw err;
				}
			}
		} catch (err) {
			return {
				status: 'error',
				error: `移动失败: ${fromInput} -> ${toInput}（${err instanceof Error ? err.message : String(err)}）`,
			};
		}

		return {
			status: 'success',
			result: overwritten
				? `已移动并覆盖: ${fromInput} -> ${toInput}`
				: `已移动: ${fromInput} -> ${toInput}`,
			metadata: {
				affected_files: [fromResolved.relativePath, toResolved.relativePath],
				duration_ms: Date.now() - startedAt,
			},
		};
	}
}
