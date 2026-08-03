/**
 * GitStashTool 单测 - 注入 mock SimpleGit，验证 push/pop/list、校验与错误处理。
 */
import * as assert from 'assert';
import { GitStashTool } from '../../../tools/git/gitStash';
import { ToolValidationError } from '../../../core/errors';
import type { ToolContext } from '../../../tools/baseTool';
import type { SimpleGit } from 'simple-git';

function makeContext(): ToolContext {
	return { workspaceRoots: ['/fake/workspace'], sessionId: 'sess-1' };
}

describe('GitStashTool', () => {
	it('push 带 message 调用 stash(["push","-m",message])', async () => {
		// Arrange
		let stashArgs: string[] | undefined;
		const git = {
			checkIsRepo: async () => true,
			stash: async (args?: string[]) => {
				stashArgs = args;
				return '';
			},
		} as unknown as SimpleGit;
		const tool = new GitStashTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'push', message: 'wip' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(stashArgs, ['push', '-m', 'wip']);
		assert.ok(result.result?.includes('wip'));
	});

	it('push 不带 message 调用 stash(["push"])', async () => {
		// Arrange
		let stashArgs: string[] | undefined;
		const git = {
			checkIsRepo: async () => true,
			stash: async (args?: string[]) => {
				stashArgs = args;
				return '';
			},
		} as unknown as SimpleGit;
		const tool = new GitStashTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'push' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(stashArgs, ['push']);
	});

	it('pop 成功恢复 stash', async () => {
		// Arrange
		let stashArgs: string[] | undefined;
		const git = {
			checkIsRepo: async () => true,
			stash: async (args?: string[]) => {
				stashArgs = args;
				return '';
			},
		} as unknown as SimpleGit;
		const tool = new GitStashTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'pop' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(stashArgs, ['pop']);
	});

	it('pop 无 stash 条目返回友好错误', async () => {
		// Arrange
		const git = {
			checkIsRepo: async () => true,
			stash: async () => {
				throw new Error('No stash entries found.');
			},
		} as unknown as SimpleGit;
		const tool = new GitStashTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'pop' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, '没有 stash 条目可恢复');
	});

	it('list 返回 stash 条目', async () => {
		// Arrange
		let stashArgs: string[] | undefined;
		const git = {
			checkIsRepo: async () => true,
			stash: async (args?: string[]) => {
				stashArgs = args;
				return 'stash@{0}: WIP on main';
			},
		} as unknown as SimpleGit;
		const tool = new GitStashTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'list' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(stashArgs, ['list']);
		const payload = JSON.parse(result.result!);
		assert.ok(payload.stash.includes('stash@{0}'));
	});

	it('非 git 仓库返回 error', async () => {
		// Arrange
		const git = { checkIsRepo: async () => false } as unknown as SimpleGit;
		const tool = new GitStashTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ action: 'push' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, '当前工作区不是 git 仓库');
	});

	it('validate 拒绝非法 action', () => {
		const tool = new GitStashTool();
		assert.throws(() => tool.validate({ action: 'invalid' }), ToolValidationError);
	});

	it('validate 接受合法参数', () => {
		const tool = new GitStashTool();
		tool.validate({ action: 'push', message: 'wip' });
		tool.validate({});
	});
});
