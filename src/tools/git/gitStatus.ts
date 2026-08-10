/**
 * git_status - 查询工作区状态（只读）。
 *
 * 返回当前分支、跟踪分支，以及已暂存 / 未暂存 / 未跟踪文件列表。
 * 文件列表超过阈值时截断并标注 truncated 与 total。
 */
import {
	BaseTool,
	type ToolContext,
	type ToolExecutionResult,
} from '../baseTool';
import { createGitClient, type GitToolOptions } from './gitClient';
import type { ToolSchema } from '../../core/types';
import type { SimpleGit, StatusResult } from 'simple-git';
import * as logger from '../../logger';

/** 各文件列表的截断阈值。 */
const MAX_FILES = 200;

/** 已暂存文件条目。 */
interface StagedFile {
	readonly file: string;
	readonly index: string;
}

/** 未暂存文件条目。 */
interface UnstagedFile {
	readonly file: string;
	readonly workingDir: string;
}

/** 从 StatusResult 映射出的简化状态。 */
interface MappedStatus {
	readonly currentBranch: string | null;
	readonly trackingBranch: string | null;
	readonly staged: StagedFile[];
	readonly unstaged: UnstagedFile[];
	readonly untracked: string[];
	readonly truncated?: boolean;
	readonly total?: number;
}

/** 将 StatusResult 映射为面向消费者的简化结构。 */
function mapStatus(status: StatusResult): MappedStatus {
	const staged: StagedFile[] = [];
	const unstaged: UnstagedFile[] = [];
	for (const f of status.files) {
		if (f.index !== ' ' && f.index !== '?') {
			staged.push({ file: f.path, index: f.index });
		}
		if (f.working_dir !== ' ' && f.working_dir !== '?') {
			unstaged.push({ file: f.path, workingDir: f.working_dir });
		}
	}
	const untracked = status.not_added;

	const total = staged.length + unstaged.length + untracked.length;
	let truncated = false;
	let stagedOut = staged;
	let unstagedOut = unstaged;
	let untrackedOut = untracked;
	if (staged.length > MAX_FILES) {
		stagedOut = staged.slice(0, MAX_FILES);
		truncated = true;
	}
	if (unstaged.length > MAX_FILES) {
		unstagedOut = unstaged.slice(0, MAX_FILES);
		truncated = true;
	}
	if (untracked.length > MAX_FILES) {
		untrackedOut = untracked.slice(0, MAX_FILES);
		truncated = true;
	}

	const result: MappedStatus = {
		currentBranch: status.current,
		trackingBranch: status.tracking,
		staged: stagedOut,
		unstaged: unstagedOut,
		untracked: untrackedOut,
		...(truncated ? { truncated: true, total } : {}),
	};
	return result;
}

export class GitStatusTool extends BaseTool {
	readonly schema: ToolSchema = {
		name: 'git_status',
		description: '查询工作区 git 状态：当前分支、暂存/未暂存/未跟踪文件列表。',
		parameters: { type: 'object', properties: {} },
		permissions: 'read',
	};

	private readonly createClient: (workspaceRoot: string) => SimpleGit;

	constructor(opts: GitToolOptions = {}) {
		super();
		this.createClient = opts.createClient ?? createGitClient;
	}

	async execute(
		_args: Record<string, unknown>,
		context: ToolContext
	): Promise<ToolExecutionResult> {
		const startedAt = Date.now();
		const root = context.workspaceRoots[0];
		if (!root) {
			logger.error('[git_status] 执行失败 - 错误=未打开工作区');
			return { status: 'error', error: '未打开工作区' };
		}
		const git = this.createClient(root);
		logger.log(`[git_status] 开始执行 - cwd=${root}`);

		if (!(await git.checkIsRepo())) {
			logger.error(`[git_status] 执行失败 - 错误=当前工作区不是 git 仓库, cwd=${root}`);
			return { status: 'error', error: '当前工作区不是 git 仓库' };
		}

		const status = await git.status();
		const mapped = mapStatus(status);
		logger.log(`[git_status] 执行完成 - staged=${mapped.staged.length}, unstaged=${mapped.unstaged.length}, untracked=${mapped.untracked.length}, truncated=${mapped.truncated ? '是' : '否'}, duration_ms=${Date.now() - startedAt}`);

		return {
			status: 'success',
			result: JSON.stringify(mapped, null, 2),
			metadata: { duration_ms: Date.now() - startedAt },
		};
	}
}
