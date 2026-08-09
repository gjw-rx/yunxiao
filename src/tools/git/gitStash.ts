/**
 * git.stash - 暂存管理（write 权限，路由层统一审批）。
 *
 * 三种操作：
 * - push（默认）：暂存当前改动（可选 message）
 * - pop：恢复最近的 stash 条目
 * - list：列出 stash 条目
 *
 * 无 stash 条目可恢复时返回友好错误。
 */
import {
	BaseTool,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import { ToolValidationError } from '../../core/errors';
import { createGitClient, type GitToolOptions } from './gitClient';
import type { ToolSchema } from '../../core/types';
import type { SimpleGit } from 'simple-git';
import * as logger from '../../logger';

type StashAction = 'push' | 'pop' | 'list';

const VALID_ACTIONS: readonly StashAction[] = ['push', 'pop', 'list'];

/** 无 stash 条目时的常见错误模式。 */
const NO_STASH_PATTERN = /no stash entries|no stash found|does not have a stash/i;

export class GitStashTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'git.stash',
		description: '暂存管理：暂存改动 / 恢复 stash / 列出 stash 条目。',
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['push', 'pop', 'list'],
					description: '操作类型（默认 push）',
				},
				message: { type: 'string', description: 'push 时的暂存说明（可选）' },
			},
		},
		permissions: 'write',
	};

	private readonly createClient: (workspaceRoot: string) => SimpleGit;

	constructor(opts: GitToolOptions = {}) {
		super();
		this.createClient = opts.createClient ?? createGitClient;
	}

	validate(args: Record<string, unknown>): void {
		if (args.action !== undefined) {
			if (!VALID_ACTIONS.includes(args.action as StashAction)) {
				throw new ToolValidationError(
					'参数 action 必须为 push | pop | list'
				);
			}
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const startedAt = Date.now();
		const root = context.workspaceRoots[0];
		if (!root) {
			return { status: 'error', error: '未打开工作区' };
		}
		const git = this.createClient(root);

		if (!(await git.checkIsRepo())) {
			return { status: 'error', error: '当前工作区不是 git 仓库' };
		}

		const action = (args.action as StashAction | undefined) ?? 'push';
		logger.log(`[git.stash] 开始执行 - cwd=${root}, action=${action}, messageLen=${typeof args.message === 'string' ? args.message.length : 0}`);

		if (action === 'list') {
			const list = await git.stash(['list']);
			logger.log(`[git.stash] 执行完成 - action=list, stashCount=${list.length}, duration_ms=${Date.now() - startedAt}`);
			return {
				status: 'success',
				result: JSON.stringify({ stash: list }, null, 2),
				metadata: { duration_ms: Date.now() - startedAt },
			};
		}

		if (action === 'pop') {
			try {
				await git.stash(['pop']);
				logger.log(`[git.stash] 执行完成 - action=pop, duration_ms=${Date.now() - startedAt}`);
				return {
					status: 'success',
					result: '已恢复最近的 stash 条目',
					metadata: { duration_ms: Date.now() - startedAt },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error(`[git.stash] 执行失败 - action=pop, 错误=${msg}`);
				if (NO_STASH_PATTERN.test(msg)) {
					return {
						status: 'error',
						error: '没有 stash 条目可恢复',
					};
				}
				return { status: 'error', error: `恢复 stash 失败: ${msg}` };
			}
		}

		// action === 'push'
		const message = args.message;
		const stashArgs =
			typeof message === 'string' && message.length > 0
				? ['push', '-m', message]
				: ['push'];
		await git.stash(stashArgs);
		logger.log(`[git.stash] 执行完成 - action=push, messageLen=${typeof message === 'string' ? message.length : 0}, duration_ms=${Date.now() - startedAt}`);
		return {
			status: 'success',
			result:
				typeof message === 'string' && message.length > 0
					? `已暂存更改: ${message}`
					: '已暂存更改',
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}
}
