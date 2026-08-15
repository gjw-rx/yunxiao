/**
 * fs_move_file - 移动/重命名文件（write 权限，经审批网关）。
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
import { hasVersionConflict } from './fileVersion';
import * as logger from '../../logger';

export class MoveFileTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs_move_file',
		description: '移动/重命名工作区内文件，自动创建目标父目录（write，需审批）。',
		parameters: {
			type: 'object',
			properties: {
				from: { type: 'string', description: '相对工作区根的源路径' },
				to: { type: 'string', description: '相对工作区根的目标路径' },
				expectedVersion: { type: 'string', description: '可选：源文件读取时获得的版本，用于检测并发修改' },
			},
			required: ['from', 'to'],
		},
		permissions: 'write',
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
		logger.log(`[fs_move_file] 开始 - from=${fromInput}, to=${toInput}`);

		// 1. 解析 from / to
		let fromResolved, toResolved;
		try {
			[fromResolved, toResolved] = await Promise.all([
				resolveWithinRoots(fromInput, context.workspaceRoots, { followSymlinks: true }),
				resolveWithinRoots(toInput, context.workspaceRoots, { followSymlinks: true }),
			]);
		} catch (err) {
			if (err instanceof PathGuardError) {
				logger.error(`[fs_move_file] 路径解析失败 - from=${fromInput}, to=${toInput}, error=${err.message}`);
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
		if (await hasVersionConflict(fromResolved.fsPath, args.expectedVersion)) {
			logger.error(`[fs_move_file] 版本冲突未移动 - from=${fromInput}`);
			return { status: 'error', error: `源文件已被并发修改，未移动: ${fromInput}`, metadata: { retryable: false } };
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

		// 4.5 记录回滚快照（源文件必存在；覆盖目标存在时一并记录，供 turn 回滚恢复）
		if (context.sessionId && context.turnUserSeq !== undefined && context.rollbackRecorder) {
			await context.rollbackRecorder.record({
				sessionId: context.sessionId,
				userSeq: context.turnUserSeq,
				fsPath: fromResolved.fsPath,
				relativePath: fromResolved.relativePath,
				existedBefore: true,
			});
			if (overwritten) {
				await context.rollbackRecorder.record({
					sessionId: context.sessionId,
					userSeq: context.turnUserSeq,
					fsPath: toResolved.fsPath,
					relativePath: toResolved.relativePath,
					existedBefore: true,
				});
			}
		}
		if (context.sessionId && context.turnUserSeq !== undefined && context.changeRecorder) {
			await context.changeRecorder.recordBefore({
				sessionId: context.sessionId,
				userSeq: context.turnUserSeq,
				fsPath: fromResolved.fsPath,
				relativePath: fromResolved.relativePath,
			});
			await context.changeRecorder.recordBefore({
				sessionId: context.sessionId,
				userSeq: context.turnUserSeq,
				fsPath: toResolved.fsPath,
				relativePath: toResolved.relativePath,
			});
		}

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
			logger.error(`[fs_move_file] 移动失败 - from=${fromInput}, to=${toInput}, error=${err instanceof Error ? err.message : String(err)}`);
			return {
				status: 'error',
				error: `移动失败: ${fromInput} -> ${toInput}（${err instanceof Error ? err.message : String(err)}）`,
			};
		}
		if (context.sessionId && context.turnUserSeq !== undefined && context.changeRecorder) {
			await context.changeRecorder.recordAfter({
				sessionId: context.sessionId,
				userSeq: context.turnUserSeq,
				fsPath: fromResolved.fsPath,
				relativePath: fromResolved.relativePath,
			});
			await context.changeRecorder.recordAfter({
				sessionId: context.sessionId,
				userSeq: context.turnUserSeq,
				fsPath: toResolved.fsPath,
				relativePath: toResolved.relativePath,
			});
		}

		logger.log(`[fs_move_file] 完成 - from=${fromInput}, to=${toInput}, overwritten=${overwritten}, duration_ms=${Date.now() - startedAt}`);
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
