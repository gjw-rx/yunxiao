/**
 * code.edit - 精准代码编辑（write 权限，自行处理审批：先 diff 预览再确认）。
 *
 * 两种模式：
 * - { path, oldString, newString }：精确替换。oldString 须在文件中唯一出现（0=未找到，>1=多处匹配）。
 * - { path, patch }：应用 unified diff（经 diffEngine，含上下文匹配与冲突检测）。
 *
 * 流程：pathGuard 解析 -> 重读文件（防并发覆盖）-> 计算 proposed -> 生成 diff ->
 *   写 proposed 到临时预览文件 -> vscode.diff 预览 -> 审批 -> 通过则原子 rename 应用，拒绝则 cancelled。
 * handlesOwnApproval=true：路由层跳过统一审批，由本工具在 execute 内弹一次（预览后）。
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
import { resolveWithinRoots } from '../fs/pathGuard';
import { PathGuardError, ToolValidationError } from '../../core/errors';
import type { ToolSchema } from '../../core/types';
import { createDiff, applyDiff } from '../diff/diffEngine';
import { getFileVersion, getFileVersionFromContent } from '../fs/fileVersion';
import { DiffViewer } from '../diff/diffViewer';
import type { ApprovalGateway } from '../../core/approvalGateway';

/** code.edit 构造依赖。 */
export interface CodeEditToolOptions {
	readonly approval: ApprovalGateway;
	readonly diffViewer?: DiffViewer;
}

export class CodeEditTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'code.edit',
		description: '精准编辑工作区内文件：精确字符串替换或应用 unified diff，含 diff 预览与冲突检测。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '相对工作区根的目标文件路径' },
				oldString: { type: 'string', description: '要替换的原字符串（须唯一出现）' },
				newString: { type: 'string', description: '替换后的新字符串' },
				patch: { type: 'string', description: 'unified diff patch（与 oldString/newString 二选一）' },
				expectedVersion: { type: 'string', description: '可选：读取时获得的文件版本，用于检测并发修改' },
			},
			required: ['path'],
		},
		permissions: 'write',
		site: 'local',
	};

	/** 自行处理审批（diff 预览后再确认）。 */
	readonly handlesOwnApproval = true;

	private readonly approval: ApprovalGateway;
	private readonly diffViewer: DiffViewer;

	constructor(opts: CodeEditToolOptions) {
		super();
		this.approval = opts.approval;
		this.diffViewer = opts.diffViewer ?? new DiffViewer();
	}

	validate(args: Record<string, unknown>): void {
		requireStringArg(args, 'path');
		const hasReplace =
			typeof args.oldString === 'string' && typeof args.newString === 'string';
		const hasPatch = typeof args.patch === 'string';
		if (!hasReplace && !hasPatch) {
			throw new ToolValidationError('须提供 oldString+newString 或 patch 之一');
		}
		if (hasReplace && hasPatch) {
			throw new ToolValidationError('oldString/newString 与 patch 不可同时提供');
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const inputPath = args.path as string;
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

		// 2. 重读文件（防并发覆盖；不信任之前 read 的缓存）
		let content: string;
		try {
			content = await fs.readFile(resolved.fsPath, 'utf8');
		} catch {
			return { status: 'error', error: `文件不存在或不可读: ${inputPath}` };
		}
		const baseVersion = getFileVersionFromContent(content);
		if (args.expectedVersion !== undefined && (typeof args.expectedVersion !== 'string' || baseVersion !== args.expectedVersion)) {
			return { status: 'error', error: `文件已被并发修改，未应用编辑: ${inputPath}`, metadata: { retryable: false } };
		}

		// 3. 计算 proposed
		let proposed: string;
		const hasPatch = typeof args.patch === 'string';
		if (hasPatch) {
			const result = applyDiff(content, args.patch as string);
			if (!result.ok) {
				return {
					status: 'error',
					error: `patch 冲突，未应用: ${result.conflict}`,
				};
			}
			proposed = result.result;
		} else {
			const oldString = args.oldString as string;
			const newString = args.newString as string;
			// 换行符归一化：LLM 发来的 oldString/newString 可能用 \n，
			// 但文件可能是 \r\n（Windows）。将入参换行符对齐到文件实际风格，避免精确匹配失败。
			const normalized = normalizeLineEndings(content, oldString, newString);
			const count = countOccurrences(content, normalized.oldString);
			if (count === 0) {
				return { status: 'error', error: `未找到要替换的字符串（oldString 不在文件中）` };
			}
			if (count > 1) {
				return {
					status: 'error',
					error: `多处匹配（${count} 处），请提供更多上下文使 oldString 唯一`,
				};
			}
			proposed = content.replace(normalized.oldString, normalized.newString);
		}

		if (proposed === content) {
			return { status: 'success', result: '无变化', metadata: { duration_ms: Date.now() - startedAt } };
		}

		// 4. 生成 diff
		const diff = createDiff(content, proposed, resolved.relativePath);

		// 5. 写 proposed 到临时预览文件
		const dir = path.dirname(resolved.fsPath);
		const previewPath = path.join(
			dir,
			`.${path.basename(resolved.fsPath)}.${crypto.randomUUID()}.code-edit-preview`
		);
		try {
			await fs.writeFile(previewPath, proposed, 'utf8');
			// 6. diff 预览
			await this.diffViewer.showDiff(
				resolved.fsPath,
				previewPath,
				`code.edit: ${inputPath}`
			);
		} catch {
			await fs.rm(previewPath, { force: true, recursive: true }).catch(() => { });
			// 预览失败不阻断应用（降级为无预览）
		}

		// 7. 审批（自行处理）
		const summary = this.buildSummary(inputPath, hasPatch ? 'patch' : 'replace', diff);
		const decision = await this.approval.requestApproval(
			'code.edit',
			summary,
			context.sessionId,
			undefined,
			{ workspaceId: context.workspaceRoots.join('|'), resourcePattern: resolved.relativePath }
		);

		// 8. 应用或取消
		if (decision === 'deny' || context.abortSignal?.aborted) {
			await fs.rm(previewPath, { force: true, recursive: true }).catch(() => { });
			return {
				status: 'cancelled',
				error: context.abortSignal?.aborted ? '执行已取消' : '用户拒绝执行',
				metadata: { duration_ms: Date.now() - startedAt },
			};
		}

		try {
			const currentContent = await fs.readFile(resolved.fsPath, 'utf8');
			if (currentContent !== content) {
				await fs.rm(previewPath, { force: true, recursive: true }).catch(() => { });
				return {
					status: 'error',
					error: `文件已被并发修改，未应用审批前生成的编辑: ${inputPath}`,
					metadata: { retryable: false, duration_ms: Date.now() - startedAt },
				};
			}
		} catch {
			await fs.rm(previewPath, { force: true, recursive: true }).catch(() => { });
			return {
				status: 'error',
				error: `文件已被并发修改或删除，未应用审批前生成的编辑: ${inputPath}`,
				metadata: { retryable: false, duration_ms: Date.now() - startedAt },
			};
		}

		if (context.abortSignal?.aborted) {
			await fs.rm(previewPath, { force: true, recursive: true }).catch(() => { });
			return {
				status: 'cancelled',
				error: '执行已取消',
				metadata: { duration_ms: Date.now() - startedAt },
			};
		}

		try {
			// 原子应用：rename 预览文件到目标
			await fs.rename(previewPath, resolved.fsPath);
		} catch (err) {
			await fs.rm(previewPath, { force: true, recursive: true }).catch(() => { });
			return {
				status: 'error',
				error: `应用编辑失败: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		return {
			status: 'success',
			result: `已应用 1 处编辑: ${inputPath}`,
			metadata: {
				diff,
				base_version: baseVersion,
				applied_version: await getFileVersion(resolved.fsPath),
				affected_files: [resolved.relativePath],
				duration_ms: Date.now() - startedAt,
			},
		};
	}

	/** 构造审批摘要：路径 + 模式 + diff 片段（截断防过长）。 */
	private buildSummary(inputPath: string, mode: string, diff: string): string {
		const snippet = diff.length > 600 ? diff.slice(0, 600) + '\n...(diff 已截断)' : diff;
		return `code.edit 将修改 ${inputPath}（${mode} 模式）：\n${snippet}`;
	}
}

/** 统计子串出现次数（空串返回 0）。 */
function countOccurrences(haystack: string, needle: string): number {
	if (needle === '') {
		return 0;
	}
	let count = 0;
	let i = 0;
	while ((i = haystack.indexOf(needle, i)) !== -1) {
		count++;
		i += needle.length;
	}
	return count;
}

/**
 * 将 oldString/newString 的换行符对齐到文件内容的实际换行风格。
 * 文件用 \r\n（Windows）时，入参的 \n 会被转为 \r\n；反之亦然。
 * 若入参与文件风格一致则原样返回。
 */
function normalizeLineEndings(
	fileContent: string,
	oldString: string,
	newString: string
): { oldString: string; newString: string } {
	const fileHasCrlf = fileContent.includes('\r\n');
	const inputHasCrlf = oldString.includes('\r\n');

	if (fileHasCrlf && !inputHasCrlf) {
		// 文件是 CRLF，入参是 LF -> 入参转 CRLF
		return {
			oldString: oldString.replace(/\n/g, '\r\n'),
			newString: newString.replace(/\n/g, '\r\n'),
		};
	}
	if (!fileHasCrlf && inputHasCrlf) {
		// 文件是 LF，入参是 CRLF -> 入参转 LF
		return {
			oldString: oldString.replace(/\r\n/g, '\n'),
			newString: newString.replace(/\r\n/g, '\n'),
		};
	}
	return { oldString, newString };
}
