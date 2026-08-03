/**
 * GitCommitTool 单测 - 注入 mock SimpleGit，验证提交、无暂存、安全校验与错误处理。
 */
import * as assert from 'assert';
import { GitCommitTool } from '../../../tools/git/gitCommit';
import { ToolValidationError } from '../../../core/errors';
import type { ToolContext } from '../../../tools/baseTool';
import type { SimpleGit, CommitResult } from 'simple-git';

function makeContext(): ToolContext {
	return { workspaceRoots: ['/fake/workspace'], sessionId: 'sess-1' };
}

function makeCommitResult(sha: string): CommitResult {
	return {
		author: null,
		branch: 'main',
		commit: sha,
		root: false,
		summary: { changes: 1, insertions: 1, deletions: 0 },
	};
}

describe('GitCommitTool', () => {
	it('成功提交返回 sha', async () => {
		// Arrange
		let committedMessage: string | undefined;
		const git = {
			checkIsRepo: async () => true,
			commit: async (message: string) => {
				committedMessage = message;
				return makeCommitResult('abc1234');
			},
		} as unknown as SimpleGit;
		const tool = new GitCommitTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ message: 'fix: 修复问题' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(committedMessage, 'fix: 修复问题');
		assert.strictEqual(result.result, '已提交: abc1234');
		assert.strictEqual(typeof result.metadata?.duration_ms, 'number');
	});

	it('无已暂存更改返回友好错误', async () => {
		// Arrange
		const git = {
			checkIsRepo: async () => true,
			commit: async () => {
				throw new Error('nothing to commit, working tree clean');
			},
		} as unknown as SimpleGit;
		const tool = new GitCommitTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ message: 'msg' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, '没有已暂存的更改可提交');
	});

	it('非 git 仓库返回 error', async () => {
		// Arrange
		const git = { checkIsRepo: async () => false } as unknown as SimpleGit;
		const tool = new GitCommitTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ message: 'msg' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, '当前工作区不是 git 仓库');
	});

	it('validate 拒绝空 message', () => {
		const tool = new GitCommitTool();
		assert.throws(() => tool.validate({ message: '' }), ToolValidationError);
	});

	it('validate 拒绝包含 --no-verify 的 message', () => {
		const tool = new GitCommitTool();
		assert.throws(() => tool.validate({ message: 'test --no-verify' }), ToolValidationError);
	});

	it('validate 拒绝包含 --amend 的 message', () => {
		const tool = new GitCommitTool();
		assert.throws(() => tool.validate({ message: 'test --amend' }), ToolValidationError);
	});

	it('validate 接受合法 message', () => {
		const tool = new GitCommitTool();
		tool.validate({ message: '正常的提交信息' });
	});
});
