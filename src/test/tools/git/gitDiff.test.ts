/**
 * GitDiffTool 单测 - 注入 mock SimpleGit，验证三种模式、截断、校验与错误处理。
 */
import * as assert from 'assert';
import { GitDiffTool } from '../../../tools/git/gitDiff';
import { ToolValidationError } from '../../../core/errors';
import type { ToolContext } from '../../../tools/baseTool';
import type { SimpleGit } from 'simple-git';

function makeContext(): ToolContext {
	return { workspaceRoots: ['/fake/workspace'], sessionId: 'sess-1' };
}

describe('GitDiffTool', () => {
	it('默认 unstaged 模式调用 diff() 无参数', async () => {
		// Arrange
		let diffArgs: string[] | undefined;
		const git = {
			checkIsRepo: async () => true,
			diff: async (args?: string[]) => {
				diffArgs = args;
				return 'diff content';
			},
		} as unknown as SimpleGit;
		const tool = new GitDiffTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.strictEqual(diffArgs, undefined);
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.diff, 'diff content');
		assert.strictEqual(payload.mode, 'unstaged');
	});

	it('staged 模式调用 diff(["--cached"])', async () => {
		// Arrange
		let diffArgs: string[] | undefined;
		const git = {
			checkIsRepo: async () => true,
			diff: async (args?: string[]) => {
				diffArgs = args;
				return 'staged diff';
			},
		} as unknown as SimpleGit;
		const tool = new GitDiffTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ mode: 'staged' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(diffArgs, ['--cached']);
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.mode, 'staged');
	});

	it('ref 模式调用 diff([base])', async () => {
		// Arrange
		let diffArgs: string[] | undefined;
		const git = {
			checkIsRepo: async () => true,
			diff: async (args?: string[]) => {
				diffArgs = args;
				return 'ref diff';
			},
		} as unknown as SimpleGit;
		const tool = new GitDiffTool({ createClient: () => git });

		// Act
		const result = await tool.execute({ mode: 'ref', base: 'main' }, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		assert.deepStrictEqual(diffArgs, ['main']);
	});

	it('截断：超过 10000 字符 -> truncated=true, total_chars 正确', async () => {
		// Arrange
		const bigDiff = 'a'.repeat(10_001);
		const git = {
			checkIsRepo: async () => true,
			diff: async () => bigDiff,
		} as unknown as SimpleGit;
		const tool = new GitDiffTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'success');
		const payload = JSON.parse(result.result!);
		assert.strictEqual(payload.truncated, true);
		assert.strictEqual(payload.total_chars, 10_001);
		assert.ok(payload.diff.startsWith('a'.repeat(100)));
		assert.ok(payload.diff.includes('截断'));
	});

	it('非 git 仓库返回 error', async () => {
		// Arrange
		const git = { checkIsRepo: async () => false } as unknown as SimpleGit;
		const tool = new GitDiffTool({ createClient: () => git });

		// Act
		const result = await tool.execute({}, makeContext());

		// Assert
		assert.strictEqual(result.status, 'error');
		assert.strictEqual(result.error, '当前工作区不是 git 仓库');
	});

	it('validate 拒绝非法 mode', () => {
		const tool = new GitDiffTool();
		assert.throws(() => tool.validate({ mode: 'invalid' }), ToolValidationError);
	});

	it('validate 拒绝 ref 模式缺少 base', () => {
		const tool = new GitDiffTool();
		assert.throws(() => tool.validate({ mode: 'ref' }), ToolValidationError);
	});

	it('validate 接受合法参数', () => {
		const tool = new GitDiffTool();
		tool.validate({ mode: 'ref', base: 'main' });
		tool.validate({});
	});
});
