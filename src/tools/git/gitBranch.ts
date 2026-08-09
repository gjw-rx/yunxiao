/**
 * git.branch - 分支管理（write 权限，路由层统一审批）。
 *
 * 三种操作：
 * - list（默认）：列出本地分支，标记当前分支
 * - create：创建并切换到新本地分支
 * - checkout：切换到已有分支
 *
 * 切换失败（如存在未提交更改）时返回友好错误。
 */
import {
	BaseTool,
	requireStringArg,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import { ToolValidationError } from '../../core/errors';
import { createGitClient, type GitToolOptions } from './gitClient';
import type { ToolSchema } from '../../core/types';
import type { SimpleGit } from 'simple-git';
import * as logger from '../../logger';

type BranchAction = 'list' | 'create' | 'checkout';

const VALID_ACTIONS: readonly BranchAction[] = ['list', 'create', 'checkout'];

/** 未提交更改导致切换失败的常见错误模式。 */
const UNCOMMITTED_PATTERN = /please commit your changes|would be overwritten|local changes/i;

export class GitBranchTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'git.branch',
		description: '分支管理：列出 / 创建 / 切换本地分支。',
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['list', 'create', 'checkout'],
					description: '操作类型（默认 list）',
				},
				name: { type: 'string', description: 'create/checkout 的分支名' },
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
			if (!VALID_ACTIONS.includes(args.action as BranchAction)) {
				throw new ToolValidationError(
					'参数 action 必须为 list | create | checkout'
				);
			}
		}
		if (args.action === 'create' || args.action === 'checkout') {
			requireStringArg(args, 'name');
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

		const action = (args.action as BranchAction | undefined) ?? 'list';
		logger.log(`[git.branch] 开始执行 - cwd=${root}, action=${action}, name=${args.name ?? '未指定'}`);

		if (action === 'list') {
			const summary = await git.branch();
			const branches = Object.values(summary.branches).map((b) => ({
				name: b.name,
				current: b.current,
				commit: b.commit,
				label: b.label,
			}));
			logger.log(`[git.branch] 执行完成 - action=list, branches=${branches.length}, current=${summary.current}, duration_ms=${Date.now() - startedAt}`);
			return {
				status: 'success',
				result: JSON.stringify(
					{
						current: summary.current,
						detached: summary.detached,
						branches,
					},
					null,
					2
				),
				metadata: { duration_ms: Date.now() - startedAt },
			};
		}

		const name = args.name as string;

		if (action === 'create') {
			try {
				await git.checkoutLocalBranch(name);
				return {
					status: 'success',
					result: `已创建并切换到分支: ${name}`,
					metadata: { duration_ms: Date.now() - startedAt },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error(`[git.branch] 执行失败 - action=create, name=${name}, 错误=${msg}`);
				return { status: 'error', error: `创建分支失败: ${msg}` };
			}
		}

		// action === 'checkout'
		try {
			await git.checkout(name);
			logger.log(`[git.branch] 执行完成 - action=checkout, name=${name}, duration_ms=${Date.now() - startedAt}`);
			return {
				status: 'success',
				result: `已切换到分支: ${name}`,
				metadata: { duration_ms: Date.now() - startedAt },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`[git.branch] 执行失败 - action=checkout, name=${name}, 错误=${msg}`);
			if (UNCOMMITTED_PATTERN.test(msg)) {
				return {
					status: 'error',
					error: '切换分支失败：有未提交的更改，请先提交或暂存',
				};
			}
			return { status: 'error', error: `切换分支失败: ${msg}` };
		}
	}
}
