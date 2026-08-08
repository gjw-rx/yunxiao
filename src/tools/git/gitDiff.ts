/**
 * git.diff - 查询工作区差异（只读）。
 *
 * 三种模式：
 * - unstaged（默认）：未暂存的改动
 * - staged：已暂存的改动（--cached）
 * - ref：与指定 base 提交/分支的差异
 *
 * diff 输出超过阈值时截断（保留开头）并标注截断信息。
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

/** diff 输出截断阈值（字符）。 */
const MAX_DIFF_CHARS = 10_000;

type DiffMode = 'unstaged' | 'staged' | 'ref';

const VALID_MODES: readonly DiffMode[] = ['unstaged', 'staged', 'ref'];

export class GitDiffTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'git.diff',
		description: '查询工作区差异：未暂存、已暂存或与指定引用的差异。',
		parameters: {
			type: 'object',
			properties: {
				mode: {
					type: 'string',
					enum: ['unstaged', 'staged', 'ref'],
					description: '差异模式（默认 unstaged）',
				},
				base: {
					type: 'string',
					description: 'ref 模式下的对比基准（提交哈希或分支名）',
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
		if (args.mode !== undefined) {
			if (!VALID_MODES.includes(args.mode as DiffMode)) {
				throw new ToolValidationError(
					'参数 mode 必须为 unstaged | staged | ref'
				);
			}
		}
		if (args.mode === 'ref') {
			if (typeof args.base !== 'string' || args.base.length === 0) {
				throw new ToolValidationError('ref 模式需要 base 参数');
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

		const mode = (args.mode as DiffMode | undefined) ?? 'unstaged';
		let diffOutput: string;
		if (mode === 'staged') {
			diffOutput = await git.diff(['--cached']);
		} else if (mode === 'ref') {
			diffOutput = await git.diff([args.base as string]);
		} else {
			diffOutput = await git.diff();
		}

		let truncated = false;
		let totalChars: number | undefined;
		if (diffOutput.length > MAX_DIFF_CHARS) {
			totalChars = diffOutput.length;
			diffOutput =
				diffOutput.slice(0, MAX_DIFF_CHARS) +
				`\n\n...[diff 已截断，保留前 ${MAX_DIFF_CHARS} 字符，共 ${totalChars} 字符]...`;
			truncated = true;
		}

		const payload: {
			diff: string;
			mode: string;
			truncated?: boolean;
			total_chars?: number;
		} = { diff: diffOutput, mode };
		if (truncated) {
			payload.truncated = true;
			payload.total_chars = totalChars;
		}

		return {
			status: 'success',
			result: JSON.stringify(payload, null, 2),
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}
}
