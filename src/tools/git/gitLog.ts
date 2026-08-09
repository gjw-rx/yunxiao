/**
 * git.log - 查询提交历史（只读）。
 *
 * 返回最近 maxCount 条提交（默认 20，上限 200），可按路径过滤。
 * 每条提交包含 hash、作者、日期与提交信息首行。
 */
import {
	BaseTool,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import { ToolValidationError } from '../../core/errors';
import { createGitClient, type GitToolOptions } from './gitClient';
import type { ToolSchema } from '../../core/types';
import type { DefaultLogFields, SimpleGit } from 'simple-git';

/** 默认返回条数。 */
const DEFAULT_MAX_COUNT = 20;
/** 条数硬上限，防单次调用拉取过多提交。 */
const MAX_COUNT_LIMIT = 200;

/** 面向消费者的提交条目。 */
interface LogEntry {
	readonly hash: string;
	readonly author: string;
	readonly date: string;
	readonly message: string;
}

export class GitLogTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'git.log',
		description: '查询 git 提交历史：最近 maxCount 条提交（默认 20），可按路径过滤。',
		parameters: {
			type: 'object',
			properties: {
				maxCount: {
					type: 'number',
					description: '返回提交条数上限（默认 20，最大 200）',
				},
				path: {
					type: 'string',
					description: '仅返回影响该路径的提交',
				},
			},
		},
		permissions: 'read',
	};

	private readonly createClient: (workspaceRoot: string) => SimpleGit;

	constructor(opts: GitToolOptions = {}) {
		super();
		this.createClient = opts.createClient ?? createGitClient;
	}

	validate(args: Record<string, unknown>): void {
		if (args.maxCount !== undefined) {
			if (
				typeof args.maxCount !== 'number' ||
				!Number.isInteger(args.maxCount) ||
				args.maxCount < 1 ||
				args.maxCount > MAX_COUNT_LIMIT
			) {
				throw new ToolValidationError(
					`参数 maxCount 必须为 1-${MAX_COUNT_LIMIT} 之间的整数`
				);
			}
		}
		if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length === 0)) {
			throw new ToolValidationError('参数 path 必须为非空字符串');
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

		const maxCount = (args.maxCount as number | undefined) ?? DEFAULT_MAX_COUNT;
		const file = args.path as string | undefined;
		const summary = await git.log({
			maxCount,
			...(file ? { file } : {}),
		});

		const commits: LogEntry[] = summary.all.map((c: DefaultLogFields) => ({
			hash: c.hash,
			author: c.author_name,
			date: c.date,
			message: c.message,
		}));

		return {
			status: 'success',
			result: JSON.stringify({ commits, count: commits.length }, null, 2),
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}
}
