/**
 * fs_delete_file - 删除文件/空目录（destructive 权限，经审批网关）。
 * 优先移入系统回收站（vscode.workspace.fs useTrash）；不可用时回退永久删除并标注。
 * 删除函数可注入，便于无 vscode 单测。
 */
import { promises as fs } from 'fs';
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

type VsCodeApi = typeof import('vscode');
function vscodeApi(): VsCodeApi {
	return require('vscode');
}

/** 删除结果：permanent 标注是否为永久删除（非回收站）。 */
export interface DeleteResult {
	permanent: boolean;
}

/** 可注入的删除函数（测试用）。默认：vscode 回收站 -> Node fs.rm 回退。 */
export type DeleteFn = (fsPath: string, recursive: boolean) => Promise<DeleteResult>;

/** 默认删除：优先回收站，失败回退永久删除。 */
const defaultDeleteFn: DeleteFn = async (fsPath, recursive): Promise<DeleteResult> => {
	try {
		const vscode = vscodeApi();
		await vscode.workspace.fs.delete(vscode.Uri.file(fsPath), {
			useTrash: true,
			recursive,
		});
		return { permanent: false };
	} catch {
		// 回收站不可用 -> 永久删除
		await fs.rm(fsPath, { recursive, force: true });
		return { permanent: true };
	}
};

export class DeleteFileTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'fs_delete_file',
		description: '删除工作区内文件或目录，优先移入回收站（destructive，需审批）。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '相对工作区根的目标路径' },
				recursive: { type: 'boolean', description: '目录是否递归删除（默认 false）' },
				expectedVersion: { type: 'string', description: '可选：读取时获得的文件版本，用于检测并发修改' },
			},
			required: ['path'],
		},
		permissions: 'destructive',
	};

	private readonly deleteFn: DeleteFn;

	constructor(opts?: { deleteFn?: DeleteFn }) {
		super();
		this.deleteFn = opts?.deleteFn ?? defaultDeleteFn;
	}

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'path');
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const inputPath = args.path as string;
		const recursive = args.recursive === true;
		const startedAt = Date.now();
		logger.log(`[fs_delete_file] 开始 - path=${inputPath}, recursive=${recursive}`);

		// 1. 路径安全解析
		let resolved;
		try {
			resolved = await resolveWithinRoots(inputPath, context.workspaceRoots, {
				followSymlinks: true,
			});
		} catch (err) {
			if (err instanceof PathGuardError) {
				logger.error(`[fs_delete_file] 路径解析失败 - path=${inputPath}, error=${err.message}`);
				return { status: 'error', error: err.message };
			}
			throw err;
		}

		// 2. 存在性检查
		try {
			await fs.stat(resolved.fsPath);
		} catch {
			return { status: 'error', error: `文件不存在: ${inputPath}` };
		}
		if (await hasVersionConflict(resolved.fsPath, args.expectedVersion)) {
			logger.error(`[fs_delete_file] 版本冲突未删除 - path=${inputPath}`);
			return { status: 'error', error: `文件已被并发修改，未删除: ${inputPath}`, metadata: { retryable: false } };
		}

		// 2.5 记录回滚快照（删除前保存内容，供 turn 回滚恢复）
		if (context.sessionId && context.turnUserSeq !== undefined && context.rollbackRecorder) {
			await context.rollbackRecorder.record({
				sessionId: context.sessionId,
				userSeq: context.turnUserSeq,
				fsPath: resolved.fsPath,
				relativePath: resolved.relativePath,
				existedBefore: true,
			});
		}

		// 3. 删除
		try {
			const result = await this.deleteFn(resolved.fsPath, recursive);
			logger.log(`[fs_delete_file] 完成 - path=${inputPath}, permanent=${result.permanent}, duration_ms=${Date.now() - startedAt}`);
			return {
				status: 'success',
				result: result.permanent
					? `已永久删除: ${inputPath}（回收站不可用）`
					: `已移入回收站: ${inputPath}`,
				metadata: {
					affected_files: [resolved.relativePath],
					duration_ms: Date.now() - startedAt,
				},
			};
		} catch (err) {
			logger.error(`[fs_delete_file] 删除失败 - path=${inputPath}, error=${err instanceof Error ? err.message : String(err)}`);
			return {
				status: 'error',
				error: `删除失败: ${inputPath}（${err instanceof Error ? err.message : String(err)}）`,
			};
		}
	}
}
