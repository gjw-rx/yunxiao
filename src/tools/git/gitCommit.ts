/**
 * git_commit - 提交已暂存的更改（write 权限，路由层统一审批）。
 *
 * 安全：提交信息中禁止 --no-verify / --amend（防止绕过钩子或篡改历史）。
 * 无已暂存更改时返回友好错误。
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

/** 禁止出现在提交信息中的危险选项。 */
const UNSAFE_MESSAGE_PATTERN = /--no-verify|--amend/;

export class GitCommitTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'git_commit',
		description: '提交已暂存的更改（提交信息禁止 --no-verify / --amend）。',
		parameters: {
			type: 'object',
			properties: {
				message: { type: 'string', description: '提交信息' },
			},
			required: ['message'],
		},
		permissions: 'write',
	};

	private readonly createClient: (workspaceRoot: string) => SimpleGit;

	constructor(opts: GitToolOptions = {}) {
		super();
		this.createClient = opts.createClient ?? createGitClient;
	}

	validate(args: Record<string, unknown>): void {
		const message = requireStringArg(args, 'message');
		if (UNSAFE_MESSAGE_PATTERN.test(message)) {
			throw new ToolValidationError(
				'提交信息不允许包含 --no-verify 或 --amend'
			);
		}
	}

	async execute(
		args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const startedAt = Date.now();
		const root = context.workspaceRoots[0];
		if (!root) {
			logger.error('[git_commit] 执行失败 - 错误=未打开工作区');
			return { status: 'error', error: '未打开工作区' };
		}
		const git = this.createClient(root);

		if (!(await git.checkIsRepo())) {
			logger.error(`[git_commit] 执行失败 - 错误=当前工作区不是 git 仓库, cwd=${root}`);
			return { status: 'error', error: '当前工作区不是 git 仓库' };
		}

		const message = args.message as string;
		logger.log(`[git_commit] 开始执行 - cwd=${root}, messageLen=${message.length}`);
		try {
			const result = await git.commit(message);
			logger.log(`[git_commit] 执行完成 - commit=${result.commit}, duration_ms=${Date.now() - startedAt}`);
			return {
				status: 'success',
				result: `已提交: ${result.commit}`,
				metadata: { duration_ms: Date.now() - startedAt },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`[git_commit] 执行失败 - 错误=${msg}, messageLen=${message.length}`);
			if (/nothing to commit|no changes added/i.test(msg)) {
				return {
					status: 'error',
					error: '没有已暂存的更改可提交',
				};
			}
			return { status: 'error', error: `提交失败: ${msg}` };
		}
	}
}
